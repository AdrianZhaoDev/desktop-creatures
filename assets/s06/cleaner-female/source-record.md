# S06 female development asset

Created 2026-09-13 with GPT-6 Astra xhigh and Blender 5.2.1 LTS. Tool version is measured; no claim of a selectable image model. Original parametric mesh, palette microtexture, shared 50-ish bone rig, sampled IK poses and GLB export in `tools/s06/build-cleaners.py`. No Mimi/other legacy geometry was used.

Reference: `../../../docs/steam-v1/reference/cleaner-female-v2.png`, SHA-256 `00ec97ac3cc01b328ad11a26050b64a76369e24a73711b1fd6ec041b4ca03003`. User approved v1 direction on 2026-09-12 and authorized v2 detail correction; final 3D is not approved. Reference prompt provenance remains in the shared reference source record.

Structural choices: approximately 4.5 head units, fixed foot sole origin, +X anatomical left, one removable back pack, separate grip-origin broom and carry bag. Female has six skirt bones, a thick modeled A-line shell, paired cream apron panels, covered dark safety shorts and one left waist pouch (hidden-side ambiguity resolved here). Male has one outer cargo pocket per leg and the same core skeleton and motion timings. Skin and clothing have blended continuous elbows/knees; shoulders are voxel unified, with artist retopology still pending. All palette UVs map into the included packed 1K texture. No real-time cloth, no root motion, no sprite route.

Eight editable Actions: idle/walk/jump_start/jump_air/land/climb/clean/carry. Clean is 1.2 s, visual event only, no damage or settlement authority. Runtime integration must rotate the whole actor to face travel and apply simulation placement. Blender source stores editable semantic parts; GLB merges them to one skinned mesh/four material groups.

Pending review: face/hair fidelity, adult-youth proportions, garment folds, shoulder deformation, grip orientation, foot sliding against motion speed, complete swept skirt/leg collision and 96/120/160 DIP readability. Numerical finite-pose checks cannot certify these. Preview PNGs are QA evidence of real 3D only.

## Measured final pass

GLB SHA-256: `c14bfb0247dda833e3da9698e73c0cee35a46dbf6ea40d66839a9d816cb48b3f`. Source SHA-256: `2e1a6eeb92598aac72fbe2d85fb7d9de131392a4f38dd65b0f6863fe0656a5d1`.

Blender source mesh sampling covers 9 phases for each of 8 clips, 72 poses per appearance. Evaluated vertices are finite. The brush-tip plane deviation is below 0.000003 model units; Three.js additionally checks the actual exported attachment. Female lower-skirt/leg surface-overlap samples report zero under the restricted test described in animation-check.json. These results do not certify all inter-frame intersections or human visual quality.

The broom and bag each include an editable source copy with actor placement context (tool-broom-source.blend and carry-bag-source.blend); the runtime prop GLBs contain the prop only. Their origin is the grip. ToolMount and BagMount preserve an upright tool in the clean/carry poses.

Known remaining visible issues: procedural face and hair differ in finesse from the concept, fingers need proper contact curl, the climbing skirt fans too stiffly, and motion speed needs physical displacement matching. Package remains development-only pending user art review.

## Broom 96 DIP readability revision

2026-09-13 parent visual review requested stronger 96 DIP tool readability without changing the character. `tools/s06/refine-broom.py` updates only the independent broom: shaft radius 0.027 → 0.047, grip radius 0.040 → 0.060, brush width 0.56 → 0.72 model units; charcoal/cream contrast with existing coral accents. Grip origin, total length and -1.92 contact plane remain unchanged. All actor GLBs/sources, animations, rigs, texture files and carry-bag assets remain byte-identical (see broom-v2-build.json).

New tool GLB SHA-256: `4ddf5c98a8639dae33377d76e0c1929b9741d17196f5927f73cedc8893d7a604`. Tool source SHA-256: `1e8f1a2e5dff16d12ad828f7fa0832053845627e708baa8364d042a482ef4e43`. Source copies preserve actor placement context. This remains a procedural development asset pending art review.
