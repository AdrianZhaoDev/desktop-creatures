import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { CampaignApplication } from '../application/campaign-application';
import { CampaignAudioDirector } from '../audio/director';
import { audioEventsForReceipt } from '../audio/event-mapping';
import { createWebAudioCampaignOutput } from '../audio/web-audio';
import { CampaignSessionV4, createRustCampaignStorage } from '../campaign-session-v4';
import { NativeCampaignBridge } from '../native/bridge';
import { createTauriCampaignHost } from '../native/tauri-host';
import { CampaignRenderer } from '../rendering/campaign-renderer';
import { AnonymousFaultCounter, SupportBundleExporter } from '../support-bundle';
import { mountCampaignApplicationUi } from '../ui/campaign-lobby';
import { CampaignInputAdapter } from './input';
import { createHostRunIdentity, createMachineLocalPorts, createMemoryCampaignStorage } from './ports';
import { CampaignProductionRuntime } from './runtime';
import { bindPracticeInput } from './practice-input';
import { CampaignPlacementSelection } from './placement';
import type { CampaignPointer } from './input';
import { CampaignInterfaceMode } from './interface-mode';
import { nativeBinOccluder, readCampaignUiOccluders } from './occlusion';
import { BrowserSupportBundleSavePort, mountSupportBundleExport, TauriSupportBundleSavePort } from './support-export';
import type { BinGeometry } from '../native/types';
import type { CampaignDisplayInfo, CampaignDisplayState } from '../native/types';
import { parseDisplayState } from '../native/validation';
import { CampaignDisplayController } from './display-move';
import { mountCampaignDisplayControls } from './display-controls';
import '../ui/campaign-ui.css';
import './runtime.css';


/** Native secondary overlays are deliberately passive: opening the same local profile twice
 * would create two authorities. The fixed primary WebView moves without recreating its Session. */
async function passiveNativeOverlay(root: HTMLElement): Promise<{ dispose(): Promise<void> }> {
  root.replaceChildren();
  const timer = window.setInterval(() => { void invoke('render_heartbeat').catch(() => {}); }, 2000);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return; disposed = true; clearInterval(timer); window.removeEventListener('pagehide', onHide);
  };
  const onHide = () => { void dispose(); };
  window.addEventListener('pagehide', onHide);
  try { await invoke('overlay_ready'); } catch (error) { await dispose(); throw error; }
  return { dispose };
}

export async function bootCampaignProduction(): Promise<CampaignProductionRuntime | { dispose(): Promise<void> }> {
  const native = '__TAURI_INTERNALS__' in window;
  const root = document.querySelector<HTMLElement>('#overlay-root') ?? document.body.appendChild(document.createElement('main'));
  if (native && new URLSearchParams(location.search).has('display')) return passiveNativeOverlay(root);
  root.replaceChildren(); root.classList.add('campaign-runtime');
  const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', 'Campaign scene');
  const ui = document.createElement('section');
  const messages = document.createElement('aside'); messages.className = 'campaign-runtime__messages';
  const status = document.createElement('output'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const save = document.createElement('button'); save.type = 'button'; save.textContent = '保存 / Save'; save.dataset.uiAction = 'runtime.save';
  const retryExit = document.createElement('button'); retryExit.type = 'button'; retryExit.textContent = '重试保存并退出 / Retry exit'; retryExit.dataset.uiAction = 'runtime.retry-exit'; retryExit.hidden = true;
  const interfaceButton = document.createElement('button'); interfaceButton.type = 'button'; interfaceButton.textContent = '界面交互 / Enable controls'; interfaceButton.dataset.uiAction = 'runtime.interface-mode'; interfaceButton.hidden = !native;
  const support = document.createElement('div'); support.className = 'campaign-runtime__support';
  messages.append(status, save, retryExit, interfaceButton, support); root.append(canvas, ui, messages);
  const error = (message: string) => { status.textContent = message; status.setAttribute('role', 'alert'); };
  const diagnostics = new Set<string>();
  const anonymousFaults = new AnonymousFaultCounter();
  let diagnosticsEnabled = (): boolean => false;
  const diagnostic = (code: string, message: string) => {
    if (diagnosticsEnabled()) {
      anonymousFaults.record(code);
      const key = `${code}:${message}`;
      if (!diagnostics.has(key)) {
        if (diagnostics.size >= 128) diagnostics.delete(diagnostics.values().next().value!);
        diagnostics.add(key); console.info('[campaign]', key);
      }
    }
    if (code.startsWith('input-') || code.startsWith('placement-')) status.textContent = message;
  };
  let runtime: CampaignProductionRuntime | undefined;
  let renderer: CampaignRenderer | undefined;
  let audio: CampaignAudioDirector | undefined;
  let unmounted: (() => void) | undefined;
  let placement: CampaignPlacementSelection | undefined;
  let interfaceMode: CampaignInterfaceMode | undefined;
  let displayController: CampaignDisplayController | undefined;
  let displayControls: ReturnType<typeof mountCampaignDisplayControls> | undefined;
  try {
    if (native) await invoke('campaign_activate_runtime');
    const initialDisplayState = native ? parseDisplayState(await invoke('campaign_display_state')) : undefined;
    let display: CampaignDisplayInfo | null = initialDisplayState?.displays.find(item => item.id === initialDisplayState.displayId) ?? null;
    const displayId = display?.id ?? 'practice';
    const viewport = { widthDip: Math.max(120, window.innerWidth), heightDip: Math.max(120, window.innerHeight), dpiScale: window.devicePixelRatio || 1 };
    // Both hosts keep settings/tutorial in machine-local WebView storage, never in V4.
    const machineStorage = window.localStorage;
    const local = createMachineLocalPorts(machineStorage);
    const session = await CampaignSessionV4.open({ profile: 'local', storage: native ? createRustCampaignStorage(invoke) : createMemoryCampaignStorage(), viewport,
      liveOptions: { now: () => performance.now(), checkpointIntervalMs: 7500 } });
    let input: CampaignInputAdapter;
    const application = await CampaignApplication.open({ session, ...local,
      systemLanguage: navigator.language,
      runIdentity: createHostRunIdentity({ sequenceStorage: machineStorage, existingRunIds: () => {
        const campaign = session.snapshot().campaign;
        return [...campaign.meta.settledRunIds, ...(campaign.activeRun ? [campaign.activeRun.runId] : [])];
      } }),
      placementContext: { resolve: command => placement!.request(command) },
      viewContext: { read: () => ({ availableDisplays: native
        ? [{ id: 'primary', label: '系统主屏 / System primary' },
          ...((displayController?.getState().native ?? initialDisplayState)?.displays.map(item => ({ id: item.id, label: item.name ?? item.id })) ?? [])]
        : [{ id: 'practice', label: 'Practice' }] }) },
    });
    diagnosticsEnabled = () => application.settingsSnapshot().diagnosticsConsent;
    // Saved display is a next-run preference; an existing run retains this owner binding.
    if (!native && application.settingsSnapshot().gameplay.detectionMode !== 'practice') await application.dispatch(application.createCommand({ type: 'settings.update', path: 'gameplay.detectionMode', value: 'practice' }));
    renderer = new CampaignRenderer({ canvas, ...viewport, quality: application.settingsSnapshot().visual.quality,
      onDiagnostic: message => diagnostic('renderer', message),
      // Informational 3D dock just below the opaque toolbar. The existing bag
      // control remains the native drag handle and displays authoritative load.
      toolDock: () => {
        const toolbar = ui.querySelector('.campaign-ui__toolbar')?.getBoundingClientRect();
        return { x: toolbar ? toolbar.left + 32 : 40, y: toolbar ? toolbar.bottom + 58 : viewport.heightDip - 40 };
      },
      detailedEffects: () => {
        const visual = application.settingsSnapshot().visual;
        return visual.motionEffects !== 'off' && visual.flashes !== 'off';
      },
    });
    audio = new CampaignAudioDirector(createWebAudioCampaignOutput(), application.settingsSnapshot().audio);
    let presentationHasRun = application.applicationSnapshot().mode === 'run';
    let presentationReady = false;
    let presentationStopped = true;
    let menuOwnsInterfaceMode = false;
    const syncInterfacePresentation = (): void => {
      if (native && presentationReady && !presentationStopped) void interfaceMode?.presentation(presentationHasRun);
    };
    const view = mountCampaignApplicationUi(ui, application.applicationSnapshot(), {
      createCommand: body => application.createCommand(body),
      onCommand: command => runtime!.dispatch(command),
      onHomeAction: (houseId, action) => runtime!.interactHome(houseId, action),
      onRefresh: () => { runtime?.refresh(true); },
      onMenuOpenChange: open => {
        if (!native) return;
        if (open) {
          placement?.cancel();
          owner.pause('runtime:interface', false);
          menuOwnsInterfaceMode = !interfaceMode?.enabled;
          if (menuOwnsInterfaceMode) void interfaceMode?.set(true);
        } else if (menuOwnsInterfaceMode) {
          menuOwnsInterfaceMode = false;
          void interfaceMode?.set(false);
        } else if (interfaceMode?.enabled) {
          owner.pause('runtime:interface', true);
        }
      },
    });
    unmounted = () => view.destroy();
    let bin: { geometry: BinGeometry; at: number } | undefined;
    const syncBinAudio = () => {
      if (native) void emitTo('trash-bin', 'bin://audio-settings', application.settingsSnapshot().audio)
        .catch(error => diagnostic('bin-audio-settings', String(error)));
    };
    runtime = new CampaignProductionRuntime({ session, application, scheduler: {
      now: () => performance.now(), request: callback => requestAnimationFrame(callback), cancel: handle => cancelAnimationFrame(handle),
    }, surfaceNow: () => Date.now(), viewport, displayId, practice: !native, surfaceFallback: native, renderer, audio, view,
      error: message => { error(message); retryExit.hidden = !message.includes('尚未退出'); }, diagnostic,
      onGrab: event => { if (!placement?.handleGrab(event)) input.handleGrab(event); },
      onScopeChanging: () => { input?.cancelGesture(); placement?.cancel(); },
      onDisplayPreparing: async () => { view.closeMenu(); await interfaceMode?.set(false); },
      onBinGeometry: geometry => { bin = geometry ? { geometry, at: Date.now() } : undefined; },
      onAudioSettings: syncBinAudio,
      readTongueOccluders: () => {
        const foreground = readCampaignUiOccluders(root);
        if (!foreground) return undefined;
        if (!native) return foreground;
        // Captured desktop scenery is behind the always-on-top actors. Foreground
        // blockers are the current opaque UI and the separate native recycling window.
        if (!display || !bin || Date.now() - bin.at > 500) return undefined;
        const nativeBin = nativeBinOccluder(bin.geometry, display.position, viewport.dpiScale);
        return nativeBin ? [...foreground, nativeBin] : undefined;
      },
      onStopped: stopped => {
        presentationStopped = stopped;
        root.dataset.stopped = String(stopped);
        if (stopped) { placement?.cancel(); view.closeMenu(); void interfaceMode?.set(false); }
        else syncInterfacePresentation();
      },
      onPresentation: hasRun => {
        presentationHasRun = hasRun;
        syncInterfacePresentation();
        displayControls?.update();
        placement?.refresh();
        canvas.hidden = !hasRun;
        canvas.style.pointerEvents = !native && hasRun && application.uiSnapshot().equippedTool ? 'auto' : 'none';
      },
    });
    const owner = runtime;
    if (native) owner.own(await listen('bin://audio-request', syncBinAudio));
    let bridge: NativeCampaignBridge | undefined;
    let pointer = { x: 0, y: 0 };
    let selectedPointer: CampaignPointer | undefined;
    let practiceBin: HTMLElement | undefined;
    if (!native) {
      practiceBin = document.createElement('div'); practiceBin.className = 'campaign-runtime__practice-bin';
      practiceBin.textContent = '练习投入口 / Practice bin'; practiceBin.setAttribute('aria-label', 'Practice recycling aperture');
      root.append(practiceBin);
    }
    input = new CampaignInputAdapter({ session, scope: () => owner.scope(), surface: () => owner.surface(),
      equippedTool: () => application.uiSnapshot().equippedTool, uiRoot: () => root,
      pointer: async () => selectedPointer ?? ({ displayId: owner.scope().displayId, localDip: native ? await invoke<{ x: number; y: number }>('cursor_position_local') : pointer }),
      hitBin: point => {
        if (bridge) return bridge.hitBin(point);
        if (!practiceBin) return false;
        const rect = practiceBin.getBoundingClientRect();
        return Math.hypot(point.x - (rect.left + rect.width / 2), point.y - (rect.top + rect.height / 2)) <= 24;
      }, now: () => Date.now(), diagnostic, enabled: () => owner.acceptingInput,
      onChanged: () => owner.refresh(true), onTutorialEvent: event => owner.tutorial(event),
      onHouseClick: houseId => {
        void owner.interactHome(houseId, 'door').then(result => { status.textContent = result.message; }).catch(() => { status.textContent = '房屋互动失败，请重试。'; });
        view.openHomeControls(houseId);
      },
      onReceipt: (action, receipt, repeated) => {
        if (!native || action !== 'bag-dispose') {
          for (const event of audioEventsForReceipt(action, receipt, repeated)) audio!.emit(event);
        }
        // Presentation only: rewards remain committed exactly once by disposeBag.
        if (native && action === 'bag-dispose' && receipt.ok && !repeated) {
          void emitTo('trash-bin', 'bin://celebrate').catch(error => diagnostic('bin-feedback', String(error)));
        }
      },
    });
    placement = new CampaignPlacementSelection({ scope: () => owner.scope(), surface: () => owner.surface(), now: () => Date.now(),
      enabled: () => input.acceptingWorldInput, ready: () => !!session.snapshot().campaign.activeRun,
      resolveAt: async (command, selected) => {
        selectedPointer = selected;
        try { return await input.placementContext.resolve(command); } finally { selectedPointer = undefined; }
      }, onPrompt: message => { status.textContent = message ? '请点击屏幕底边投放设备；Esc 取消。 / Click the bottom edge to place; Esc cancels.' : ''; }, diagnostic });
    owner.own(() => placement?.dispose());
    if (native) {
      const host = createTauriCampaignHost();
      interfaceMode = new CampaignInterfaceMode(host, enabled => {
        if (!enabled && view.isMenuOpen()) { menuOwnsInterfaceMode = false; view.closeMenu(); }
        input.cancelGesture(); owner.setInteracting(false); owner.pause('runtime:interface', enabled && !view.isMenuOpen());
        interfaceButton.textContent = enabled ? '返回桌面 / Return to desktop' : '界面交互 / Enable controls';
        status.textContent = enabled ? '现在可点击界面启用声音；Esc 返回穿透模式。 / Click controls to enable sound; Esc returns to desktop.' : '';
        if (enabled) void bridge?.cancel('tool-change');
      }, error);
      owner.own(() => interfaceMode!.dispose());
      await interfaceMode.start();
      bridge = new NativeCampaignBridge({ host, scope: owner.scope(), bindingGeneration: initialDisplayState!.bindingGeneration, emit: event => owner.handleNative(event),
        regions: () => interfaceMode?.enabled ? [] : [...input.regions(), ...placement!.regions()], equippedTool: () => application.uiSnapshot().equippedTool,
        allowSurfaceFallback: true });
      owner.attachBridge(bridge);
      await bridge.start();
      displayController = new CampaignDisplayController(host, {
        prepare: () => owner.prepareDisplayMove(),
        bind: async (state: CampaignDisplayState, next: CampaignDisplayInfo) => { await owner.bindDisplay(state, next); display = next; },
        waitForSurface: next => owner.waitForDisplaySurface(next),
        release: () => owner.releaseDisplayMove(),
      });
      owner.attachDisplayController(displayController); owner.own(() => displayController?.dispose());
      const displayRoot = document.createElement('div'); messages.append(displayRoot);
      displayControls = mountCampaignDisplayControls(displayRoot, displayController, () => application.settingsSnapshot().language);
      owner.own(() => displayControls?.dispose());
      displayController.subscribe(() => owner.refresh(true));
      await displayController.start();
    } else owner.own(bindPracticeInput(root, input, owner, point => { pointer = point; }));
    const supportExporter = new SupportBundleExporter(() => {
      const faultSnapshot = anonymousFaults.snapshot();
      const hasFault = (...codes: string[]) => faultSnapshot.some(item => codes.includes(item.code));
      const surface = owner.surface();
      return {
        runtimeKind: native ? 'tauri' : 'browser-practice',
        settings: application.settingsSnapshot(),
        run: session.snapshot().campaign.activeRun,
        anonymousFaults: faultSnapshot,
        moduleHealth: {
          campaign: hasFault('runtime-consistency', 'navigation-budget') ? 'degraded' : 'ok',
          renderer: hasFault('renderer') ? 'degraded' : 'ok',
          audio: 'ok',
          storage: session.dirty ? 'degraded' : 'ok',
          input: hasFault('input', 'native-bridge') ? 'degraded' : native ? 'ok' : 'practice',
          desktopSurface: !native ? 'practice' : surface?.valid ? 'ok' : hasFault('desktop-surface') ? 'degraded' : 'unavailable',
        },
      };
    }, native ? new TauriSupportBundleSavePort(invoke) : new BrowserSupportBundleSavePort());
    owner.own(mountSupportBundleExport(support, supportExporter));
    const placementClick = (event: PointerEvent) => {
      if ((!native || interfaceMode?.enabled) && !view.isMenuOpen() && event.isTrusted && placement?.isPending) {
        const point = { x: event.clientX, y: event.clientY }, surface = owner.surface();
        if (surface && Math.abs(point.y - surface.floorY) <= 24) {
          event.preventDefault(); event.stopPropagation();
          void placement.selectPoint({ displayId: owner.scope().displayId, localDip: point });
        }
      }
    };
    const cancelPlacement = (event: KeyboardEvent) => { if (event.key === 'Escape') placement?.cancel(); };
    document.addEventListener('pointerdown', placementClick, true); document.addEventListener('keydown', cancelPlacement, true);
    const gesture = (event: Event) => { owner.userGesture(event); if (event.type === 'pointerdown') owner.setInteracting(true); };
    const releaseGesture = () => { owner.setInteracting(false); };
    document.addEventListener('pointerdown', gesture, true); document.addEventListener('keydown', gesture, true);
    document.addEventListener('pointerup', releaseGesture, true); document.addEventListener('pointercancel', releaseGesture, true); window.addEventListener('blur', releaseGesture);
    const visibility = () => owner.setHidden(document.hidden);
    const pageExit = () => owner.pageExit();
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) location.reload(); };
    const resize = () => {
      if (native) void displayController?.refresh();
      else owner.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    };
    const manualSave = () => owner.checkpoint('manual');
    const toggleInterface = () => { void interfaceMode?.set(!interfaceMode.enabled); };
    const retry = () => { void owner.quit(); };
    save.addEventListener('click', manualSave); retryExit.addEventListener('click', retry);
    interfaceButton.addEventListener('click', toggleInterface);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('resize', resize);
    window.addEventListener('pagehide', pageExit); window.addEventListener('beforeunload', pageExit); window.addEventListener('pageshow', pageShow);
    owner.own(() => {
      document.removeEventListener('pointerdown', gesture, true); document.removeEventListener('keydown', gesture, true);
      document.removeEventListener('pointerup', releaseGesture, true); document.removeEventListener('pointercancel', releaseGesture, true); window.removeEventListener('blur', releaseGesture);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('resize', resize);
      window.removeEventListener('pagehide', pageExit); window.removeEventListener('beforeunload', pageExit); window.removeEventListener('pageshow', pageShow);
      save.removeEventListener('click', manualSave); retryExit.removeEventListener('click', retry); practiceBin?.remove();
      interfaceButton.removeEventListener('click', toggleInterface);
      document.removeEventListener('pointerdown', placementClick, true); document.removeEventListener('keydown', cancelPlacement, true);
    });
    if (!native) status.textContent = '练习模式 · 本局不写入磁盘 / Memory-only practice';
    else status.textContent = '点击“界面交互”，再点击控件以启用声音。 / Enable controls, then click to enable sound.';
    owner.start(); visibility();
    if (native) {
      const audioSettings = application.settingsSnapshot().audio;
      await invoke('update_game_menu', { mode: 'game', autoSave: true, audioEnabled: audioSettings.master > 0 && audioSettings.effects > 0, status: 'Campaign V4 · local' });
      syncBinAudio();
      await invoke('overlay_ready');
      presentationReady = true;
      presentationHasRun = application.applicationSnapshot().mode === 'run';
      if (!presentationStopped) await interfaceMode?.presentation(presentationHasRun);
    }
    return owner;
  } catch (failure) {
    if (runtime) await runtime.dispose();
    else { unmounted?.(); audio?.dispose(); renderer?.dispose(); }
    error(`启动失败 / Startup failed: ${String(failure)}`); throw failure;
  }
}
