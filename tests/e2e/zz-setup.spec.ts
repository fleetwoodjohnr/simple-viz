import { test, launch, quit, salesProject, tempDir } from './helpers'
test('setup', async () => {
  const { app, page } = await launch()
  await salesProject(app, page, tempDir())
  await quit(app)
})
