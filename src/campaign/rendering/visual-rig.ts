export interface ModelVisualTransform {
  readonly node: string;
  readonly property: 'position' | 'quaternion';
  readonly closed: readonly number[];
  readonly open: readonly number[];
}

export interface ModelVisualInteraction {
  readonly mode: 'toggle' | 'pulse';
  readonly durationSeconds: number;
  readonly transforms: readonly ModelVisualTransform[];
}

export interface ModelVisualRig {
  readonly actions?: Readonly<Record<string, { readonly clip: string; readonly loop: boolean }>>;
  readonly poses?: Readonly<Record<string, { readonly clip: string; readonly timeSeconds: number }>>;
  readonly anchors?: Readonly<Record<string, string>>;
  readonly interactions?: Readonly<Record<string, ModelVisualInteraction>>;
  readonly signalMaterials?: readonly string[];
}
