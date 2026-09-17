import {
  parseSupportBundle,
  SupportBundleExporter,
  type SupportBundle,
  type SupportBundleSavePort,
} from "../support-bundle";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface BrowserDownloadDependencies {
  readonly document: Document;
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
}

export class BrowserSupportBundleSavePort implements SupportBundleSavePort {
  constructor(private readonly dependencies: BrowserDownloadDependencies = {
    document,
    createObjectUrl: blob => URL.createObjectURL(blob),
    revokeObjectUrl: url => URL.revokeObjectURL(url),
  }) {}

  async save(bundle: SupportBundle): Promise<boolean> {
    const safe = parseSupportBundle(bundle);
    const blob = new Blob([`${JSON.stringify(safe, null, 2)}\n`], { type: "application/json" });
    const url = this.dependencies.createObjectUrl(blob);
    const anchor = this.dependencies.document.createElement("a");
    anchor.href = url;
    anchor.download = `desktop-creatures-support-${safe.exportedOn}.json`;
    anchor.hidden = true;
    this.dependencies.document.body.append(anchor);
    try { anchor.click(); }
    finally { anchor.remove(); this.dependencies.revokeObjectUrl(url); }
    return true;
  }
}

export class TauriSupportBundleSavePort implements SupportBundleSavePort {
  constructor(private readonly invoke: Invoke) {}
  async save(bundle: SupportBundle): Promise<boolean> {
    const result = await this.invoke("export_support_bundle", { supportBundle: parseSupportBundle(bundle) });
    if (typeof result !== "boolean") throw new Error("invalid support export result");
    return result;
  }
}

export const SUPPORT_EXPORT_COPY = Object.freeze({
  title: "隐私最小化支持包 / Privacy-minimized support bundle",
  description: "仅包含版本/构建指纹、匿名故障代码与计数（仅在你另行启用本机诊断后）、模块健康、粗粒度运行/暂停状态和白名单本机设置。不含截图、窗口标题、路径、用户名、机器名、SteamID、原始日志、桌面几何、战局种子或自由文本。 / Contains only version/build fingerprint, anonymous fault codes and counts (only after you separately enable local diagnostics), module health, coarse run/pause state, and allowlisted local settings. No screenshots, window titles, paths, user or machine names, SteamID, raw logs, desktop geometry, run seed, or free text.",
  localOnly: "只在你点击后保存到本机；不会自动收集、自动导出或上传。 / Saved locally only after you click; never collected, exported, or uploaded automatically.",
  button: "导出最小支持包 / Export minimal support bundle",
  busy: "正在准备本机文件…… / Preparing local file…",
  saved: "支持包已保存到你选择的位置。 / Support bundle saved to the location you chose.",
  cancelled: "已取消，未保存文件。可再次点击重试。 / Cancelled; no file was saved. Click again to retry.",
  failed: "导出失败，未上传任何内容。请再次点击重试。 / Export failed; nothing was uploaded. Click again to retry.",
});

export function renderSupportBundleExport(): string {
  const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<details class="campaign-support"><summary>${escape(SUPPORT_EXPORT_COPY.title)}</summary><p>${escape(SUPPORT_EXPORT_COPY.description)}</p><p>${escape(SUPPORT_EXPORT_COPY.localOnly)}</p><button type="button" data-support-export>${escape(SUPPORT_EXPORT_COPY.button)}</button><output role="status" aria-live="polite" aria-atomic="true"></output></details>`;
}

export function mountSupportBundleExport(root: HTMLElement, exporter: SupportBundleExporter): () => void {
  root.innerHTML = renderSupportBundleExport();
  const button = root.querySelector<HTMLButtonElement>("[data-support-export]");
  const output = root.querySelector<HTMLOutputElement>("output");
  if (!button || !output) throw new Error("support export controls unavailable");
  const onClick = async (event: MouseEvent): Promise<void> => {
    if (!event.isTrusted || exporter.busy) return;
    button.disabled = true;
    output.dataset.kind = "busy";
    output.textContent = SUPPORT_EXPORT_COPY.busy;
    try {
      const result = await exporter.exportFromUserGesture(event);
      if (result === "ignored") return;
      output.dataset.kind = result === "saved" ? "success" : "cancelled";
      output.textContent = result === "saved" ? SUPPORT_EXPORT_COPY.saved : SUPPORT_EXPORT_COPY.cancelled;
    } catch {
      output.dataset.kind = "error";
      output.textContent = SUPPORT_EXPORT_COPY.failed;
    } finally { button.disabled = false; }
  };
  button.addEventListener("click", onClick);
  return () => { button.removeEventListener("click", onClick); root.replaceChildren(); };
}
