export function supplyWindowsShell(env: NodeJS.ProcessEnv, platform: string): () => void {
  if (platform !== 'win32' || env.SHELL) return () => {}
  if (!env.ComSpec) throw new Error('Windows ComSpec is required when SHELL is missing')
  const original = env.SHELL
  env.SHELL = env.ComSpec
  return () => {
    if (original === undefined) delete env.SHELL
    else env.SHELL = original
  }
}
