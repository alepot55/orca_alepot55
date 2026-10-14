/**
 * Spawn env for a `ps` whose `lstart`/`command` output Orca parses.
 *
 * Why: macOS `ps` prints `lstart` in the locale's `%c` and vis(3)-escapes non-ASCII argv unless one
 * UTF-8 locale covers every category, so it runs wholly in en_US.UTF-8. procps-ng localizes only
 * `lstart`'s names and escapes argv by LC_CTYPE alone, so elsewhere only LC_TIME is pinned: a host
 * without en_US.UTF-8 would fall back to C and mangle non-ASCII argv.
 */
export function psOutputEnv(
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv | undefined {
  if (platform === 'win32') {
    return undefined
  }
  return platform === 'darwin'
    ? { ...process.env, LC_ALL: 'en_US.UTF-8' }
    : withCTimeLocale(process.env)
}

function withCTimeLocale(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { LC_ALL: everyCategory, ...rest } = env
  if (!everyCategory) {
    return { ...rest, LC_TIME: 'C' }
  }
  // LC_ALL would override LC_TIME, so it becomes LANG; the LC_* it already overrode go with it.
  const kept = Object.fromEntries(Object.entries(rest).filter(([name]) => !name.startsWith('LC_')))
  return { ...kept, LANG: everyCategory, LC_TIME: 'C' }
}
