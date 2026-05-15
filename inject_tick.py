with open(r'e:\Dropbox\hemitExport\GLBViewer\src\main.js', 'r', encoding='utf-8') as f:
    content = f.read()

old = """  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);
    controls.update();
    renderer.render(scene, camera);
  });"""

new = """  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);

    // Lip sync tick
    if (lipSyncPlaying && lipSyncAudioCtx) {
      const elapsed = lipSyncAudioCtx.currentTime - lipSyncStartTime;
      const cue = getActiveCue(elapsed);
      if (cue !== lipSyncCurrentShape) {
        lipSyncCurrentShape = cue;
        if (ui.lipSyncShape) ui.lipSyncShape.textContent = cue;
      }
      applyVisemeCue(cue);
    }

    controls.update();
    renderer.render(scene, camera);
  });"""

if old not in content:
    print('ERROR: pattern not found')
    exit(1)

content = content.replace(old, new, 1)

with open(r'e:\Dropbox\hemitExport\GLBViewer\src\main.js', 'w', encoding='utf-8') as f:
    f.write(content)

print(f'Done. File size: {len(content)}')
print(f'Lip sync tick present: {"lipSyncPlaying && lipSyncAudioCtx" in content}')
