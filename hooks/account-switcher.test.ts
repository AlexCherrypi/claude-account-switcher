import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-23T08:00:00.000Z')
const HOUR = 3_600_000
const CREDS = '/home/u/.claude/.credentials.json'
const CONFIG = '/home/u/.claude.json'
const STORE = '/home/u/.claude/account-switcher/accounts'

const ACCOUNT_A = { accountUuid: 'aaaa-1111', emailAddress: 'alice@work.example', organizationUuid: 'org-a', displayName: 'Alice', organizationName: 'Work Inc' }
const ACCOUNT_B = { accountUuid: 'bbbb-2222', emailAddress: 'alice@home.example', organizationUuid: 'org-b', displayName: 'Alice' }

function tokens(name: string, expiresAt = NOW + 8 * HOUR) {
  return { accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' }
}

type WorldOpts = {
  // macOS: the login in the keychain; `locked`: the keychain refuses reads.
  mac?: { locked?: boolean; refuseWrites?: number }
  windows?: boolean
  env?: Record<string, string>
}

const LOGIN_A = () => JSON.stringify({ claudeAiOauth: tokens('a1'), mcpOAuth: { srv: { token: 'keep-me' } } })

// The machine beneath the plugin: files, the keychain, the usage meter, the profile and
// the token endpoint. `usage` maps an access token (or the session's handle) to what the
// meter answers.
function world(on: On, opts: WorldOpts = {}) {
  const files = new Map<string, string>()
  const keychain = new Map<string, string>() // service -> data
  if (opts.mac) keychain.set('Claude Code-credentials', LOGIN_A())
  else if (!opts.windows) files.set(CREDS, LOGIN_A())
  files.set(CONFIG, JSON.stringify({ oauthAccount: ACCOUNT_A, numStartups: 7, projects: { '/x': {} } }, null, 2))
  const seen = {
    files,
    keychain,
    // access token -> the account and organization the profile endpoint names
    profiles: new Map<string, { accountUuid: string; organizationUuid: string }>(),
    usage: new Map<string, { five_hour: number; seven_day: number }>([
      ['at-a1', { five_hour: 91, seven_day: 40 }],
      ['session', { five_hour: 91, seven_day: 40 }],
      ['at-b1', { five_hour: 12, seven_day: 30 }],
      ['at-b2', { five_hour: 12, seven_day: 30 }],
    ]),
    // refresh token -> the pair the endpoint hands out; absent: refused
    renewals: new Map<string, string>([['rt-b1', 'b2']]),
    fetches: [] as string[],
    commands: [] as string[][],
    toasts: [] as string[],
  }
  mock.env(on, opts.windows ? { OS: 'Windows_NT', HOME: '/c/Users/u', USERPROFILE: '/win/Users/u', ...opts.env } : { HOME: '/home/u', USER: 'u', ...opts.env })
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw missing(e.path)
    return { value: text } as never
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  const macPaths = ['/usr/bin/security', '/System/Library/CoreServices']
  on('fs.exists', (_$, e) => ({ value: (opts.mac !== undefined && macPaths.includes(e.path)) || files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}/`)) }) as never)
  on('fs.list', (_$, e) => {
    const names = [...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1)).filter(n => !n.includes('/'))
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })) } as never
  })
  on('process.run', (_$, e) => {
    seen.commands.push([...e.argv])
    const done = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }) as never
    if (e.argv[0] === 'rm') files.delete(e.argv[2]!)
    if (e.argv[0] === 'security' && e.argv[1] === 'find-generic-password') {
      if (opts.mac?.locked) return done(36, '', 'security: SecKeychainSearchCopyNext: User interaction is not allowed.')
      const service = e.argv[e.argv.indexOf('-s') + 1]!
      const data = keychain.get(service)
      return data === undefined ? done(44, '', 'The specified item could not be found in the keychain.') : done(0, `${data}\n`)
    }
    const fromHex = (hex: string) => new TextDecoder().decode(new Uint8Array(hex.match(/../g)!.map(h => parseInt(h, 16))))
    const refuse = () => {
      if (!opts.mac?.refuseWrites) return false
      opts.mac.refuseWrites -= 1
      return true
    }
    if (e.argv[0] === 'security' && e.argv[1] === '-i') {
      const stdin = String(e.init?.stdin)
      // security reads a line into 4096 bytes and refuses the pieces of a longer one.
      if (stdin.length > 4096) return done(1, '', `security: unknown command "${stdin.slice(4096, 4200)}"`)
      const m = /add-generic-password -U -a "([^"]*)" -s "([^"]*)" -X "([0-9a-f]*)"/.exec(stdin)
      if (!m) return done(0, '', 'error: unknown command')
      if (refuse()) return done(1, '', `security: SecKeychainItemModifyContent: denied ${m[3]!.slice(0, 64)}`)
      keychain.set(m[2]!, fromHex(m[3]!))
      return done(0)
    }
    if (e.argv[0] === 'security' && e.argv[1] === 'add-generic-password') {
      const arg = (flag: string) => e.argv[e.argv.indexOf(flag) + 1]!
      if (refuse()) return done(1, '', `security: SecKeychainItemModifyContent: denied ${arg('-X').slice(0, 64)}`)
      keychain.set(arg('-s'), fromHex(arg('-X')))
      return done(0)
    }
    return done(0)
  })
  on('session.authorize', () => ({ value: { handle: 'session', kind: 'bearer' } }) as never)
  on('http.fetch', (_$, e) => {
    seen.fetches.push(e.url)
    const answer = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } }) as never
    if (e.url.endsWith('/v1/oauth/token')) {
      const body = JSON.parse(String(e.init?.body))
      const next = seen.renewals.get(body.refresh_token)
      if (!next) return answer(400, { error: 'invalid_grant' })
      return answer(200, { access_token: `at-${next}`, refresh_token: `rt-${next}`, expires_in: 28_800, scope: body.scope })
    }
    if (e.url.endsWith('/api/oauth/profile')) {
      const token = String(e.init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
      const who = seen.profiles.get(token)
      return who ? answer(200, { account: { uuid: who.accountUuid, email: 'x' }, organization: { uuid: who.organizationUuid } }) : answer(401, {})
    }
    if (e.url.endsWith('/api/oauth/usage')) {
      const key = e.init?.auth ?? String(e.init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
      const u = seen.usage.get(key)
      if (!u) return answer(401, { error: 'unauthorized' })
      return answer(200, {
        five_hour: { utilization: u.five_hour, resets_at: new Date(NOW + 2 * HOUR).toISOString() },
        seven_day: { utilization: u.seven_day, resets_at: new Date(NOW + 72 * HOUR).toISOString() },
      })
    }
    return answer(404, {})
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(String((e as unknown as { text: string }).text))
    return { value: undefined } as never
  })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__account-switcher__${e.name}` } }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('session.start', () => ({ cwd: '/' }) as never)
  return { seen, clock }
}

function file(seen: { files: Map<string, string> }, path: string): Record<string, any> {
  return JSON.parse(seen.files.get(path) as string)
}

// Account B, saved earlier (as a login with it would have left it).
function saveB(seen: { files: Map<string, string> }, claudeAiOauth = tokens('b1')): void {
  seen.files.set(
    `${STORE}/bbbb-2222.json`,
    JSON.stringify({
      version: 1,
      accountUuid: ACCOUNT_B.accountUuid,
      label: 'private',
      email: ACCOUNT_B.emailAddress,
      displayName: 'Alice',
      organizationName: null,
      organizationUuid: 'org-b',
      subscriptionType: 'pro',
      savedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      oauthAccount: ACCOUNT_B,
      claudeAiOauth,
    }),
  )
}

async function call($: Engine, tool: string, input: Record<string, unknown> = {}) {
  return $.tool.call({ tool: `mcp__account-switcher__${tool}`, ...input } as never) as Promise<{ result?: unknown; deny?: string }>
}

async function command($: Engine, args: string): Promise<string> {
  return String((await $.command.run({ command: 'account', args } as never)).text)
}

describe('saving', () => {
  test('saves the account signed in now on its own, with who it is', async ($, on) => {
    const { seen } = world(on)
    await $.session.start({ cwd: '/' } as never)
    const a = file(seen, `${STORE}/aaaa-1111_org-a.json`)
    expect(a.email).toBe('alice@work.example')
    expect(a.displayName).toBe('Alice')
    expect(a.organizationName).toBe('Work Inc')
    expect(a.subscriptionType).toBe('max')
    expect(a.claudeAiOauth.refreshToken).toBe('rt-a1')
    expect(a.oauthAccount).toEqual(ACCOUNT_A)
    expect(seen.commands).toContainEqual(['chmod', '600', `${STORE}/aaaa-1111_org-a.json`])
  })

  test('/account save takes a label', async ($, on) => {
    const { seen } = world(on)
    expect(await command($, 'save work')).toContain('work (alice@work.example')
    expect(file(seen, `${STORE}/aaaa-1111_org-a.json`).label).toBe('work')
  })
})

describe('limits without switching', () => {
  test('lists every account with its limits and the one with the most room', async ($, on) => {
    const { seen } = world(on)
    saveB(seen)
    const r = await call($, 'accounts')
    const text = String(r.result)
    expect(text).toContain('active: alice (alice@work.example · Alice · Work Inc)')
    expect(text).toMatch(/▶ \d\. alice – alice@work\.example/)
    expect(text).toContain('5-hour 91% (resets in 2 h 0 min) · 7-day 40%')
    expect(text).toContain('○ 1. private – alice@home.example')
    expect(text).toContain('└ 5-hour 12%')
    // No line starts with a space: Claude Code would shift it.
    expect(text.split('\n').some(l => l.startsWith(' '))).toBe(false)
    expect(text).toContain('5-hour 12%')
    expect(text).toContain('Most room elsewhere:')
    expect(text).toContain('private')
    expect(text).toContain('You may switch on your own')
    // The active account is read with the session's own credential, B with its token.
    expect(file(seen, `${STORE}/bbbb-2222.json`).lastUsage.limits[0].percent).toBe(12)
  })

  test('renews an inactive account whose token ran out, and saves the new pair', async ($, on) => {
    const { seen } = world(on)
    saveB(seen, tokens('b1', NOW - HOUR))
    const text = String((await call($, 'accounts')).result)
    expect(text).toContain('5-hour 12%')
    const b = file(seen, `${STORE}/bbbb-2222.json`)
    expect(b.claudeAiOauth.accessToken).toBe('at-b2')
    expect(b.claudeAiOauth.refreshToken).toBe('rt-b2')
    expect(b.claudeAiOauth.expiresAt).toBe(NOW + 28_800_000)
  })

  test('never renews the active account’s tokens', async ($, on) => {
    const { seen } = world(on)
    await call($, 'accounts', { refresh: true })
    expect(seen.fetches.filter(u => u.endsWith('/v1/oauth/token'))).toEqual([])
  })
})

describe('switching', () => {
  test('writes the current tokens back, then signs in with the other account', async ($, on) => {
    const { seen } = world(on)
    saveB(seen)
    await $.session.start({ cwd: '/' } as never)
    // Claude Code renewed account A's tokens since they were saved.
    seen.files.set(CREDS, JSON.stringify({ claudeAiOauth: tokens('a2'), mcpOAuth: { srv: { token: 'keep-me' } } }))

    const r = await call($, 'switch', { account: 'private', reason: '5-hour limit at 91%' })
    expect(r.deny).toBeUndefined()
    expect(String(r.result)).toContain('Switched from alice (alice@work.example')
    expect(String(r.result)).toContain('to private')

    const creds = file(seen, CREDS)
    expect(creds.claudeAiOauth.accessToken).toBe('at-b1')
    expect(creds.mcpOAuth).toEqual({ srv: { token: 'keep-me' } })
    const config = file(seen, CONFIG)
    expect(config.oauthAccount).toEqual(ACCOUNT_B)
    expect(config.numStartups).toBe(7)
    expect(config.projects).toEqual({ '/x': {} })
    expect(file(seen, `${STORE}/aaaa-1111_org-a.json`).claudeAiOauth.accessToken).toBe('at-a2')
    expect(seen.toasts.some(t => t.includes('switched to private'))).toBe(true)

    // And back: the person's own switch, by a part of the email.
    seen.usage.set('at-a2', { five_hour: 91, seven_day: 40 })
    expect(String(await command($, 'switch work'))).toContain('Switched from private')
    expect(file(seen, CREDS).claudeAiOauth.accessToken).toBe('at-a2')
    expect(file(seen, CONFIG).oauthAccount).toEqual(ACCOUNT_A)
  })

  test('says so when the target is already active', async ($, on) => {
    const { seen } = world(on)
    await $.session.start({ cwd: '/' } as never)
    expect(seen.files.has(`${STORE}/aaaa-1111_org-a.json`)).toBe(true)
    expect(String((await call($, 'switch', { account: 'alice@work', reason: 'test' })).result)).toContain('Already on')
  })

  test('refuses a target whose login no longer works, and leaves the login alone', async ($, on) => {
    const { seen } = world(on)
    saveB(seen, tokens('dead', NOW - HOUR))
    const before = seen.files.get(CREDS)
    const r = await call($, 'switch', { account: 'private', reason: 'room' })
    expect(r.deny).toMatch(/cannot be signed in: its refresh token was refused/)
    expect(seen.files.get(CREDS)).toBe(before)
    expect(file(seen, `${STORE}/bbbb-2222.json`).needsLogin).toBe(true)
  })

  test('the model switches only while the user lets it, and not back and forth', async ($, on) => {
    const { seen, clock } = world(on)
    saveB(seen)
    await $.session.start({ cwd: '/' } as never)
    expect(await command($, 'auto off')).toContain('may switch accounts on its own: no')
    expect((await call($, 'switch', { account: 'private', reason: 'room' })).deny).toMatch(/not allowed you/)
    expect(String((await call($, 'accounts')).result)).toContain('has NOT allowed you')

    await command($, 'auto on')
    expect((await call($, 'switch', { account: 'private', reason: 'room' })).deny).toBeUndefined()
    await clock.advance(60_000)
    expect((await call($, 'switch', { account: 'alice@work', reason: 'back' })).deny).toMatch(/wait/)
    await clock.advance(5 * 60_000)
    expect((await call($, 'switch', { account: 'alice@work', reason: 'back' })).deny).toBeUndefined()
  })

  test('a reason is required, and subagents may not switch', async ($, on) => {
    const { seen } = world(on)
    saveB(seen)
    expect((await call($, 'switch', { account: 'private' })).deny).toMatch(/reason/)
    expect((await call($, 'switch', { account: 'private', reason: 'x', agentId: 'sub-1' })).deny).toMatch(/main agent/)
  })

  test('honours allowModelSwitch off in the options', { options: { allowModelSwitch: false } }, async ($, on) => {
    const { seen } = world(on)
    saveB(seen)
    expect((await call($, 'switch', { account: 'private', reason: 'room' })).deny).toMatch(/not allowed you/)
    // The person may always switch.
    expect(await command($, 'switch private')).toContain('Switched')
  })
})

describe('/account', () => {
  test('labels and removes accounts', async ($, on) => {
    const { seen } = world(on)
    saveB(seen)
    await $.session.start({ cwd: '/' } as never)
    expect(await command($, 'label private home')).toContain('Labelled home')
    expect(file(seen, `${STORE}/bbbb-2222.json`).label).toBe('home')
    expect(await command($, 'remove alice@work.example')).toContain('is the active account')
    expect(await command($, 'remove home')).toContain('Removed home')
    expect(seen.files.has(`${STORE}/bbbb-2222.json`)).toBe(false)
  })

  test('an ambiguous name is refused with the candidates; an unknown one names the saved', async ($, on) => {
    const { seen } = world(on)
    saveB(seen)
    await $.session.start({ cwd: '/' } as never)
    expect(await command($, 'switch example')).toContain('fits 2 accounts')
    expect(await command($, 'switch bob')).toContain('no saved account fits "bob" (saved: private, alice)')
    expect(await command($, 'switch 1')).toContain('Switched')
  })
})

describe('macOS: the login in the keychain, the account record in ~/.claude.json', () => {
  test('switches the keychain item and the record, and writes no credentials file', async ($, on) => {
    const { seen } = world(on, { mac: {} })
    saveB(seen)
    await $.session.start({ cwd: '/' } as never)
    expect(file(seen, `${STORE}/aaaa-1111_org-a.json`).claudeAiOauth.accessToken).toBe('at-a1')
    const r = await call($, 'switch', { account: 'private', reason: 'room' })
    expect(r.deny).toBeUndefined()
    const item = JSON.parse(seen.keychain.get('Claude Code-credentials')!)
    expect(item.claudeAiOauth.accessToken).toBe('at-b1')
    expect(item.mcpOAuth).toEqual({ srv: { token: 'keep-me' } })
    expect(file(seen, CONFIG).oauthAccount).toEqual(ACCOUNT_B)
    expect(seen.files.has(CREDS)).toBe(false)
    // The secret never rides on a command line.
    expect(seen.commands.some(c => c.includes('-w') && c.some(a => a.includes('at-b1')))).toBe(false)
  })

  test('a locked keychain is an error, not a missing item: an old file beside it is not taken', async ($, on) => {
    const { seen } = world(on, { mac: { locked: true } })
    seen.files.set(CREDS, JSON.stringify({ claudeAiOauth: tokens('stale') }))
    saveB(seen)
    const r = await call($, 'switch', { account: 'private', reason: 'room' })
    expect(r.deny).toMatch(/could not read the macOS keychain item "Claude Code-credentials".*unlocked/)
    expect(file(seen, CREDS).claudeAiOauth.accessToken).toBe('at-stale')
    expect(seen.files.has(`${STORE}/aaaa-1111_org-a.json`)).toBe(false)
  })

  test('no keychain item: the file, as Claude Code does', async ($, on) => {
    const { seen } = world(on, { mac: {} })
    seen.keychain.clear()
    seen.files.set(CREDS, LOGIN_A())
    saveB(seen)
    expect((await call($, 'switch', { account: 'private', reason: 'room' })).deny).toBeUndefined()
    expect(file(seen, CREDS).claudeAiOauth.accessToken).toBe('at-b1')
    expect(seen.keychain.size).toBe(0)
  })

  test('with CLAUDE_CONFIG_DIR the item name carries the hash of that folder', async ($, on) => {
    const { seen } = world(on, { mac: {}, env: { CLAUDE_CONFIG_DIR: '/home/u/.claude-work' } })
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('/home/u/.claude-work'))
    const service = `Claude Code-credentials-${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8)}`
    expect(await command($, 'where')).toContain(`Keychain item looked for: "${service}" (account "u")`)
    void seen
  })
})

describe('Windows', () => {
  test('finds the login under USERPROFILE, not a HOME Git Bash set, and runs no chmod', async ($, on) => {
    const { seen } = world(on, { windows: true })
    // USERPROFILE is C:\Users\u there; the test engine runs on Unix paths.
    seen.files.set('/win/Users/u/.claude/.credentials.json', LOGIN_A())
    seen.files.set('/win/Users/u/.claude.json', seen.files.get(CONFIG)!)
    seen.files.delete(CONFIG)
    await $.session.start({ cwd: '/' } as never)
    expect(seen.files.has('/win/Users/u/.claude/account-switcher/accounts/aaaa-1111_org-a.json')).toBe(true)
    expect(seen.commands.some(c => c[0] === 'chmod')).toBe(false)
    const where = await command($, 'where')
    expect(where).toContain('System: Windows')
    expect(where).toContain('Saved in the store: yes – alice (alice@work.example')
    expect(where).toContain('Accounts in the store: 1 (alice)')
  })
})

describe('tokens and record kept apart', () => {
  test('a record written back by another session is set right, and no file gets the wrong tokens', async ($, on) => {
    const { seen } = world(on)
    saveB(seen)
    await $.session.start({ cwd: '/' } as never)
    await call($, 'switch', { account: 'private', reason: 'room' })
    // An older Claude Code session writes its old record back over the switch.
    seen.files.set(CONFIG, JSON.stringify({ oauthAccount: ACCOUNT_A, numStartups: 8 }, null, 2))
    const text = String((await call($, 'accounts')).result)
    expect(file(seen, CONFIG).oauthAccount).toEqual(ACCOUNT_B)
    expect(file(seen, CONFIG).numStartups).toBe(8)
    expect(file(seen, `${STORE}/aaaa-1111_org-a.json`).claudeAiOauth.accessToken).toBe('at-a1')
    expect(text).toContain('active: private')
  })

  test('renewed tokens are filed under the account the server names', async ($, on) => {
    const { seen } = world(on)
    saveB(seen)
    await $.session.start({ cwd: '/' } as never)
    // Claude Code renewed B's tokens, but the record still names A.
    seen.files.set(CREDS, JSON.stringify({ claudeAiOauth: tokens('b9') }))
    seen.profiles.set('at-b9', ACCOUNT_B)
    expect(String(await command($, 'save'))).toContain('private')
    expect(file(seen, `${STORE}/bbbb-2222.json`).claudeAiOauth.accessToken).toBe('at-b9')
    expect(file(seen, `${STORE}/aaaa-1111_org-a.json`).claudeAiOauth.accessToken).toBe('at-a1')
    expect(file(seen, CONFIG).oauthAccount).toEqual(ACCOUNT_B)
  })
})

describe('/login', () => {
  const ACCOUNT_C = { accountUuid: 'cccc-3333', emailAddress: 'alice@club.example', organizationUuid: 'org-c', displayName: 'Alice' }

  test('saves the old account with its newest tokens first, then the new one', async ($, on) => {
    const { seen, clock } = world(on)
    // The engine's /login: its dialog finishes a moment after the command ran.
    let loginAt = 0
    on('command.run', { command: 'login' }, () => {
      loginAt = NOW + 10_000
      return { text: 'Login successful' }
    })
    await $.session.start({ cwd: '/' } as never)
    // Claude Code renewed A's tokens since the last sync.
    seen.files.set(CREDS, JSON.stringify({ claudeAiOauth: tokens('a2'), mcpOAuth: { srv: { token: 'keep-me' } } }))
    seen.profiles.set('at-a2', ACCOUNT_A)
    seen.profiles.set('at-c1', ACCOUNT_C)
    await $.command.run({ command: 'login', args: '' } as never)
    expect(file(seen, `${STORE}/aaaa-1111_org-a.json`).claudeAiOauth.accessToken).toBe('at-a2')
    expect(loginAt).toBeGreaterThan(0)
    await clock.advance(10_000)
    seen.files.set(CREDS, JSON.stringify({ claudeAiOauth: tokens('c1'), mcpOAuth: { srv: { token: 'keep-me' } } }))
    seen.files.set(CONFIG, JSON.stringify({ oauthAccount: ACCOUNT_C, numStartups: 7 }, null, 2))
    await clock.advance(6_000)
    const c = file(seen, `${STORE}/cccc-3333_org-c.json`)
    expect(c.email).toBe('alice@club.example')
    expect(c.claudeAiOauth.accessToken).toBe('at-c1')
    expect(file(seen, `${STORE}/aaaa-1111_org-a.json`).claudeAiOauth.accessToken).toBe('at-a2')
    seen.usage.set('at-a2', { five_hour: 100, seven_day: 40 })
    const text = String((await call($, 'accounts')).result)
    expect(text).toContain('Accounts: 2 saved · active: alice-2 (alice@club.example · Alice)')
    expect(text).toContain('1. alice – alice@work.example')
    expect(text).toMatch(/└ 5-hour 100% .* · FULL/)
  })
})

describe('macOS: long logins and failed writes', () => {
  // A login with MCP tokens beside it: longer in hex than security -i reads in a line.
  const longLogin = () => JSON.stringify({ claudeAiOauth: tokens('a1'), mcpOAuth: { srv: { token: 'x'.repeat(3000) } } })

  test('a login too long for security -i is written as an argument', async ($, on) => {
    const { seen } = world(on, { mac: {} })
    seen.keychain.set('Claude Code-credentials', longLogin())
    saveB(seen)
    const r = await call($, 'switch', { account: 'private', reason: 'room' })
    expect(r.deny).toBeUndefined()
    const item = JSON.parse(seen.keychain.get('Claude Code-credentials')!)
    expect(item.claudeAiOauth.accessToken).toBe('at-b1')
    expect(item.mcpOAuth.srv.token.length).toBe(3000)
  })

  test('a refused write puts the old login back and shows no part of it', async ($, on) => {
    const { seen } = world(on, { mac: { refuseWrites: 1 } })
    saveB(seen)
    const before = seen.keychain.get('Claude Code-credentials')
    const r = await call($, 'switch', { account: 'private', reason: 'room' })
    expect(r.deny).toMatch(/could not write the login \(the keychain refused the write.*\) – the old login is back in place/)
    expect(r.deny).not.toMatch(/[0-9a-f]{16,}/)
    expect(seen.keychain.get('Claude Code-credentials')).toBe(before)
    expect(file(seen, CONFIG).oauthAccount).toEqual(ACCOUNT_A)
  })
})

describe('a broken login', () => {
  test('is named as such, and a switch to a saved account repairs it', async ($, on) => {
    const { seen } = world(on, { mac: {} })
    saveB(seen)
    seen.keychain.set('Claude Code-credentials', '{"claudeAiOauth":{"accessToken":"at-a1","refre')
    expect(await command($, 'where')).toContain('BROKEN')
    expect(await command($, 'switch private')).toContain('Switched')
    expect(JSON.parse(seen.keychain.get('Claude Code-credentials')!).claudeAiOauth.accessToken).toBe('at-b1')
    expect(file(seen, CONFIG).oauthAccount).toEqual(ACCOUNT_B)
  })
})

describe('names', () => {
  test('one person in two organizations: two accounts, each with a short name of its own', async ($, on) => {
    const { seen } = world(on)
    await $.session.start({ cwd: '/' } as never)
    // The same person signs in for a team: same account, another organization.
    const TEAM = { ...ACCOUNT_A, organizationUuid: 'org-team', organizationName: 'Team GmbH' }
    seen.files.set(CREDS, JSON.stringify({ claudeAiOauth: tokens('t1') }))
    seen.files.set(CONFIG, JSON.stringify({ oauthAccount: TEAM }, null, 2))
    seen.profiles.set('at-t1', TEAM)
    await command($, 'save')
    expect(file(seen, `${STORE}/aaaa-1111_org-a.json`).claudeAiOauth.accessToken).toBe('at-a1')
    const team = file(seen, `${STORE}/aaaa-1111_org-team.json`)
    expect(team.claudeAiOauth.accessToken).toBe('at-t1')
    expect(team.label).toBe('alice-2')
    // The same email fits both: refused, with both named by organization.
    expect(await command($, 'switch alice@work.example')).toMatch(/fits 2 accounts: alice \(.*Work Inc\); alice-2 \(.*Team GmbH\)/)
    // The organization's name, or the short name, picks one.
    expect(await command($, 'switch work inc')).toContain('Switched')
    expect(file(seen, CONFIG).oauthAccount.organizationUuid).toBe('org-a')
  })

  test('a label already taken is refused', async ($, on) => {
    const { seen } = world(on)
    saveB(seen)
    await $.session.start({ cwd: '/' } as never)
    expect(await command($, 'label alice private')).toContain('the label "private" is taken by private')
    expect(await command($, 'save private')).toContain('is taken')
    expect(await command($, 'label alice arbeit')).toContain('Labelled arbeit')
  })
})
