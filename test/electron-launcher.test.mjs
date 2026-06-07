import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Electron desktop launcher packages the full service startup option', async () => {
  const [packageJsonText, main, preload, renderer, html, css, buildScript, gitignore] = await Promise.all([
    readFile('package.json', 'utf-8'),
    readFile('electron/main.cjs', 'utf-8'),
    readFile('electron/preload.cjs', 'utf-8'),
    readFile('electron/launcher.js', 'utf-8'),
    readFile('electron/launcher.html', 'utf-8'),
    readFile('electron/launcher.css', 'utf-8'),
    readFile('scripts/build-electron-desktop.mjs', 'utf-8'),
    readFile('.gitignore', 'utf-8'),
  ])
  const packageJson = JSON.parse(packageJsonText)

  assert.equal(packageJson.version, '0.1.0')
  assert.equal(packageJson.main, 'electron/main.cjs')
  assert.equal(packageJson.scripts.desktop, 'electron .')
  assert.equal(packageJson.scripts['desktop:build'], 'node scripts/build-electron-desktop.mjs')
  assert.match(packageJson.devDependencies.electron, /^\^42\.3\.3$/)
  assert.match(packageJson.devDependencies['electron-builder'], /^\^26\.15\.0$/)
  assert.equal(packageJson.build.appId, 'com.robodoge.questingbeast.desktop')
  assert.equal(packageJson.build.productName, 'Questing Beast Desktop')
  assert.equal(packageJson.build.directories.output, 'dist-electron')
  assert.equal(packageJson.build.asar, false)
  assert.deepEqual(packageJson.build.win.target, [{ target: 'portable', arch: ['x64'] }])
  assert.equal(packageJson.build.portable.artifactName, 'Questing-Beast-Desktop-${version}-${arch}.exe')
  assert.match(packageJson.build.files.join('\n'), /scripts\/\*\*\//)
  assert.match(packageJson.build.files.join('\n'), /server\.mjs/)

  assert.match(main, /scripts', 'start-clean\.mjs'/)
  assert.match(main, /ELECTRON_RUN_AS_NODE/)
  assert.match(main, /launcher:start-full-services/)
  assert.match(main, /\/healthz/)
  assert.match(main, /taskkill\.exe/)
  assert.match(main, /ROBO_DOGE_ROOT/)
  assert.match(preload, /contextBridge\.exposeInMainWorld\('roboDogeLauncher'/)
  assert.match(renderer, /startFullServices/)
  assert.match(renderer, /openApp/)
  assert.match(html, /id="start-services-button"/)
  assert.match(html, /Launch full services/)
  assert.match(html, /id="open-app-button"/)
  assert.match(css, /grid-template-columns/)
  assert.match(buildScript, /repairMoonshineVadFileDependency/)
  assert.match(buildScript, /electron-builder/)
  assert.match(buildScript, /@ricky0123/)
  assert.match(gitignore, /dist-electron\//)
})
