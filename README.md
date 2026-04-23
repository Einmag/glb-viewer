# GLB PBR Viewer (Three.js)

Simple web viewer for inspecting GLB models with PBR materials.

## Features

- GLB/GLTF loading from `public/models` list
- Upload/drag-drop model loading (no code changes needed)
- HDR image-based lighting from `public/hdr` list
- Upload/drag-drop HDR loading
- Key light type selection (`directional`, `point`, `spot`, `hemisphere`, `none`)
- Optional ambient light
- Grid floor toggle
- Optional shadow receiver plane
- Shadow enable/disable toggle

## Quick start

1. Install Node.js (LTS).
2. Install dependencies:
   - `npm install`
3. Run dev server:
   - `npm run dev`
4. Open the local URL shown in terminal.

## Easy model swap (no script edits)

### Option A: Add files to public folders

1. Put GLB files in `public/models/`
2. Put HDR files in `public/hdr/`
3. Update lists:
   - `public/models/models.json`
   - `public/hdr/hdrs.json`

Example `models.json`:

```json
{
  "models": ["robot.glb", "car.glb"]
}
```

Example `hdrs.json`:

```json
{
  "hdrs": ["studio.hdr", "sunset.hdr"]
}
```

### Option B: Upload directly in UI

Use the file inputs (or drag/drop) to load a local `.glb`/`.gltf` and `.hdr` without touching project files.

## Notes for your Maya -> Blender -> GLB pipeline

This viewer works well with your current FBX->Blender->GLB flow.
As soon as your automated conversion script is ready, you can output into `public/models` and only update `models.json` (or overwrite existing file names) to keep the viewer workflow simple.
