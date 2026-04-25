# GLB Viewer Project Checklist

- [x] Verify `copilot-instructions.md` exists in `.github/`
- [x] Clarify project requirements
- [x] Scaffold the project
- [x] Customize the project
- [x] Install required extensions (none required)
- [x] Compile the project (`npm install`, `npm run build`)
- [x] Create and run task (`Run GLB Viewer (Vite)`)
- [ ] Launch the project (pending user confirmation for debug mode)
- [x] Ensure documentation is complete

## Project Notes

- Stack: Vite + Three.js
- Main scripts: `npm run dev`, `npm run build`, `npm run preview`
- Build status: successful production build on April 25, 2026
- Docs status: `README.md` and this file are present and current

## Features (April 25, 2026)
- Collapsible side panel with hamburger toggle (all screen sizes); mobile slides over viewport
- Each panel section (Model, Lighting, Ground & Shadows, Animation) independently collapsible
- HDR files: `glasshouse_interior_1k.exr` + `suburban_garden_1k.exr` listed in `hdrs.json`
- HDR exposure slider (`renderer.toneMappingExposure`, 0–3)
- Key light intensity multiplier slider (0–3×, resets to 1× on light type change)
- Ambient light intensity slider (0–2)
- Reset Camera button (restores camera to last model-framed position)
- Animation panel: detects embedded GLB clips, clip selector, play/pause/resume/stop/loop toggle

## Future: External Animation Loading
- See `/memories/repo/future-animation-loading.md` for full spec
- Phase 2: upload a separate GLB as animation source with rig mismatch diagnostics (bone name diff, track coverage report, severity levels)
