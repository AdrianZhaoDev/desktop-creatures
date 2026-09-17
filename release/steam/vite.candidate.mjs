import path from 'node:path';

// Used only by build-candidate.mjs after verifying pinned resources and new output.
export function candidateConfig(root, plugin) {
  return {
    configFile: false, root, publicDir: false, envDir: false, mode: 'production',
    css: { postcss: { plugins: [] } },
    plugins: [plugin],
    build: {
      write: false, sourcemap: false, assetsInlineLimit: 0, chunkSizeWarningLimit: 1800,
      rollupOptions: { input: { index: path.join(root, 'index.html'), trash: path.join(root, 'trash.html'), shortcuts: path.join(root, 'shortcuts.html') } },
    },
  };
}
