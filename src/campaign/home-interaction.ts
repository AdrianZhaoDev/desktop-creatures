export type HomeInteractionAction = 'door' | 'props' | 'call';
export interface HomeInteractionResult { readonly ok: boolean; readonly message: string }
