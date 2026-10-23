import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { AccountRow } from '../types'

// Account switcher
//
// 1. Keeps every Claude account the person signs in with in a file of its own, one per
//    account (<store>/<accountUuid>.json): its OAuth tokens (`claudeAiOauth`), the
//    `oauthAccount` record of ~/.claude.json, and what tells it apart at a glance –
//    email, name, organization, plan, a label of the person's.
// 2. Switches the session to another saved account: the active account's tokens are
//    written back to its file first (Claude Code renews them now and then, and the old
//    ones stop working), then the target's tokens go where Claude Code keeps its login
//    (~/.claude/.credentials.json, or the macOS keychain) and its `oauthAccount` into
//    ~/.claude.json. Claude Code notices the changed login and uses it from the next
//    request on – no restart, no /login.
// 3. Reads the 5-hour and 7-day limits of every saved account without switching to it
//    (GET /api/oauth/usage with that account's token; no model request, no tokens). An
//    inactive account's expired token is renewed with its refresh token and the new
//    pair saved at once. The active account's own tokens are never renewed here: that is
//    Claude Code's, and a renewal here would void the pair it holds.
// 4. The model can list, read and switch accounts through tools – switching only while
//    the person lets it (userConfig allowModelSwitch, /account auto on|off; on by
//    default) and not more often than the cooldown. The person has /account.
// 5. With CTM: CTM's blocks show the active account's limits and notice a switch (it
//    reads oauthAccount.accountUuid); past a pause mark they point the model to this
//    plugin before asking it to pause.
//
// Switching is machine-wide: every Claude Code session on this machine that uses the same
// config dir signs in with the account switched to.

type OAuthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scopes?: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
  [key: string]: unknown
}

type LimitKind = 'five_hour' | 'seven_day'
type Limit = { kind: LimitKind; percent: number; resetsAt: string | null }
type Usage = { at: number; limits: Limit[] }

// One file per account.
type AccountFile = {
  version: 1
  accountUuid: string
  label: string | null
  email: string | null
  displayName: string | null
  organizationName: string | null
  organizationUuid: string | null
  subscriptionType: string | null
  savedAt: string
  updatedAt: string
  oauthAccount: Record<string, unknown>
  claudeAiOauth: OAuthTokens
  lastUsage?: Usage
  // Its refresh token was refused: only a new /login with it brings it back.
  needsLogin?: boolean
  // On the allow list: the model may switch to it on its own. Otherwise it may only ask,
  // and the user confirms in a dialog the plugin opens.
  autoSwitch?: boolean
  // Excluded: the model may not switch to it at all, not even by asking. The user still can.
  modelBlocked?: boolean
}

type Account = { path: string; data: AccountFile }

// Where Claude Code keeps its login.
type Backend = { kind: 'file'; path: string } | { kind: 'keychain'; service: string; user: string }

// The login as Claude Code holds it now. `doc` is the whole credentials document (it may
// hold more than claudeAiOauth, e.g. MCP servers' tokens, which stay as they are).
type Live = {
  backend: Backend
  doc: Record<string, unknown> | null
  tokens: OAuthTokens | null
  oauthAccount: Record<string, unknown> | null
  configPath: string
  // There is a login, but it is no JSON (cut short by a write that failed): no tokens to save.
  unreadable: boolean
}

type Settings = { allowModelSwitch?: boolean }

const T_ACCOUNTS = 'mcp__account-switcher__accounts'
const T_SWITCH = 'mcp__account-switcher__switch'
const T_SAVE = 'mcp__account-switcher__save'

const API = 'https://api.anthropic.com'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_BETA = 'oauth-2025-04-20'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

const MINUTE = 60_000
const USAGE_FRESH_MS = 3 * MINUTE // a reading this young is shown as it is
const USAGE_DEMAND_GAP_MS = 30_000 // refresh: true, at most this often per account
const RENEW_MARGIN_MS = 5 * MINUTE // a token this close to its end is renewed first
const SYNC_EVERY_MS = 5 * MINUTE
const LOGIN_LOOKS_MS = [5_000, 15_000, 30_000, 60_000, 2 * MINUTE] // after /login, for the new account
const HTTP_TIMEOUT_MS = 15_000
// Past these, an account counts as full (CTM's built-in safety marks).
const FULL_AT: Record<LimitKind, number> = { five_hour: 95, seven_day: 97 }
const STORE_SETTINGS = 'settings'

let allowModelSwitchDefault = true
let cooldownMs = 5 * MINUTE
let autoSave = true
let configuredStoreDir = ''
let configuredKeychain = ''
let alwaysAsk: string[] = [] // emails, @domains or organization names, lower case
let settings: Settings | null = null
let lastModelSwitchAt = Number.NEGATIVE_INFINITY
let lastTried = new Map<string, number>() // accountUuid -> last usage fetch
let syncTimer: { cancel: () => void } | null = null
let busy: Promise<unknown> = Promise.resolve() // switches and saves run one at a time

// ---------------------------------------------------------------- Small helpers

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toast($: EngineInterface, text: string): void {
  void Promise.resolve()
    .then(() => $.ui.toast(text))
    .catch(() => undefined)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function trimSlash(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

// One at a time: two switches (or a switch and a sync) must not interleave their
// read-modify-writes of the login.
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = busy.then(fn, fn)
  busy = run.catch(() => undefined)
  return run
}

async function now($: EngineInterface): Promise<number> {
  return (await safe(() => $.clock.now())) ?? Date.now()
}

function fmtSpan(from: number, to: number): string {
  const min = Math.max(0, Math.round((to - from) / MINUTE))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h ${min % 60} min`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

function fmtPercent(n: number): string {
  return `${Math.round(n * 10) / 10}%`
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function toHex(text: string): string {
  return [...new TextEncoder().encode(text)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return new TextDecoder().decode(bytes)
}

// ---------------------------------------------------------------- Where things are

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await safe(() => $.env.get('OS'))) === 'Windows_NT'
}

// The home folder as Claude Code's os.homedir() sees it: USERPROFILE on Windows (where a
// HOME set by Git Bash or MSYS may point elsewhere), HOME everywhere else.
async function home($: EngineInterface): Promise<string | null> {
  const h = (await isWindows($))
    ? (await safe(() => $.env.get('USERPROFILE'))) || (await safe(() => $.env.get('HOME')))
    : (await safe(() => $.env.get('HOME'))) || (await safe(() => $.env.get('USERPROFILE')))
  return h ? trimSlash(h) : null
}

// Claude Code's config dir: CLAUDE_CONFIG_DIR, else ~/.claude.
async function configDir($: EngineInterface): Promise<string | null> {
  const dir = await safe(() => $.env.get('CLAUDE_CONFIG_DIR'))
  if (dir) return trimSlash(dir)
  const h = await home($)
  return h ? `${h}/.claude` : null
}

// ~/.claude.json, or .claude.json inside CLAUDE_CONFIG_DIR.
async function globalConfigPath($: EngineInterface): Promise<string | null> {
  const dir = await safe(() => $.env.get('CLAUDE_CONFIG_DIR'))
  const base = dir ? trimSlash(dir) : await home($)
  return base ? `${base}/.claude.json` : null
}

async function storeDir($: EngineInterface): Promise<string | null> {
  if (configuredStoreDir) {
    const h = await home($)
    return trimSlash(configuredStoreDir.replace(/^~(?=$|[\\/])/, h ?? '~'))
  }
  const dir = await configDir($)
  return dir ? `${dir}/account-switcher/accounts` : null
}

async function isMac($: EngineInterface): Promise<boolean> {
  if (await isWindows($)) return false
  return Boolean((await safe(() => $.fs.exists('/usr/bin/security'))) && (await safe(() => $.fs.exists('/System/Library/CoreServices'))))
}

// The keychain item Claude Code keeps its login under on macOS: "Claude Code-credentials",
// with "-<first 8 hex of sha256(config dir)>" behind it when CLAUDE_CONFIG_DIR is set.
async function keychainService($: EngineInterface): Promise<string> {
  if (configuredKeychain) return configuredKeychain
  const secure = await safe(() => $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR'))
  const dir = secure || (await safe(() => $.env.get('CLAUDE_CONFIG_DIR')))
  return dir ? `${KEYCHAIN_SERVICE}-${(await sha256Hex(trimSlash(dir).normalize('NFC'))).slice(0, 8)}` : KEYCHAIN_SERVICE
}

async function credentialsFile($: EngineInterface): Promise<string | null> {
  const secure = await safe(() => $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR'))
  const dir = secure ? trimSlash(secure) : await configDir($)
  return dir ? `${dir}/.credentials.json` : null
}

// ---------------------------------------------------------------- The live login

// `security` exits 44 when no such item is there (errSecItemNotFound).
const SECURITY_NOT_FOUND = 44

type KeychainRead = { text: string } | { missing: true } | { error: string }

async function keychainRead($: EngineInterface, service: string, user: string): Promise<KeychainRead> {
  let r
  try {
    r = await $.process.run(['security', 'find-generic-password', '-a', user, '-w', '-s', service], { timeoutMs: 10_000 })
  } catch (err) {
    return { error: errorText(err) }
  }
  if (r.exitCode === SECURITY_NOT_FOUND) return { missing: true }
  if (r.exitCode !== 0) return { error: `security exited ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 200)}` : ''}` }
  const out = r.stdout.trim()
  if (!out) return { missing: true }
  // `security -w` prints the data as hex when it is not plain text.
  return { text: out.startsWith('{') || !/^[0-9a-f]+$/i.test(out) ? out : fromHex(out) }
}

// `security -i` reads each command as one line into a buffer of 4096 bytes and cuts a
// longer one into pieces it then refuses ("unknown command"). A login with its MCP tokens
// is often longer than that in hex.
const SECURITY_LINE_MAX = 4000

// What `security` printed, without any run of hex in it: it echoes the command it refused,
// and that holds the login.
function scrub(text: string): string {
  return text.replace(/[0-9a-f]{16,}/gi, '…').replace(/\s+/g, ' ').trim().slice(0, 200)
}

async function keychainWrite($: EngineInterface, service: string, user: string, text: string): Promise<void> {
  const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`
  const hex = toHex(text)
  const line = `add-generic-password -U -a ${q(user)} -s ${q(service)} -X ${q(hex)}\n`
  // Through `security -i` where it fits, as Claude Code does, so the secret is on no
  // command line; a longer one goes as an argument (seen for a moment by processes of
  // the same user, as Claude Code does too).
  const r =
    line.length <= SECURITY_LINE_MAX
      ? await $.process.run(['security', '-i'], { stdin: line, timeoutMs: 10_000 })
      : await $.process.run(['security', 'add-generic-password', '-U', '-a', user, '-s', service, '-X', hex], { timeoutMs: 10_000 })
  // `security -i` can exit 0 and still print the refusal of a command it ran.
  if (r.exitCode !== 0 || /error|denied|not allowed|unknown command/i.test(r.stderr)) {
    throw new Error(`the keychain refused the write (security exited ${r.exitCode}${r.stderr.trim() ? `: ${scrub(r.stderr)}` : ''})`)
  }
  // Read back: only what is there counts.
  const back = await keychainRead($, service, user)
  if (!('text' in back) || back.text !== text) throw new Error('the keychain item does not hold what was written')
}

// The keychain account Claude Code files its item under: $USER, else the login name.
async function keychainUser($: EngineInterface): Promise<string> {
  const user = await safe(() => $.env.get('USER'))
  if (user) return user
  const r = await safe(() => $.process.run(['id', '-un'], { timeoutMs: 5_000 }))
  return (r?.exitCode === 0 && r.stdout.trim()) || 'claude-code-user'
}

async function readBackend($: EngineInterface): Promise<{ backend: Backend; text: string | null }> {
  const file = await credentialsFile($)
  if (await isMac($)) {
    const user = await keychainUser($)
    const service = await keychainService($)
    const r = await keychainRead($, service, user)
    if ('text' in r) return { backend: { kind: 'keychain', service, user }, text: r.text }
    // A locked keychain, or one that refused us, is no missing item: the file beside it
    // may be an old one, and taking it for the login would save or switch the wrong tokens.
    if ('error' in r) throw new Error(`could not read the macOS keychain item "${service}" (${r.error}) – is the keychain unlocked?`)
    // No keychain item: Claude Code keeps its login in the file then, as on Linux.
  }
  if (!file) throw new Error('cannot tell where Claude Code keeps its login (neither HOME nor CLAUDE_CONFIG_DIR is set)')
  const text = (await safe(() => $.fs.exists(file))) ? ((await safe(() => $.fs.read(file))) as string | undefined) ?? null : null
  return { backend: { kind: 'file', path: file }, text }
}

function parseTokens(doc: Record<string, unknown> | null): OAuthTokens | null {
  const t = doc?.claudeAiOauth
  return isObject(t) && typeof t.accessToken === 'string' && t.accessToken ? (t as OAuthTokens) : null
}

async function readGlobalConfig($: EngineInterface, path: string): Promise<Record<string, unknown>> {
  const text = await $.fs.read(path)
  const doc = JSON.parse(String(text))
  if (!isObject(doc)) throw new Error(`${path} holds no JSON object`)
  return doc
}

async function readLive($: EngineInterface): Promise<Live> {
  const configPath = await globalConfigPath($)
  if (!configPath) throw new Error('cannot find ~/.claude.json (neither HOME nor CLAUDE_CONFIG_DIR is set)')
  const { backend, text } = await readBackend($)
  let doc: Record<string, unknown> | null = null
  if (text) {
    try {
      const parsed = JSON.parse(text)
      doc = isObject(parsed) ? parsed : null
    } catch {
      doc = null
    }
  }
  const config = await safe(() => readGlobalConfig($, configPath))
  const oauthAccount = isObject(config?.oauthAccount) ? (config.oauthAccount as Record<string, unknown>) : null
  return { backend, doc, tokens: parseTokens(doc), oauthAccount, configPath, unreadable: Boolean(text?.trim()) && doc === null }
}

async function restrict($: EngineInterface, path: string): Promise<void> {
  if (await isWindows($)) return
  await safe(() => $.process.run(['chmod', '600', path], { timeoutMs: 5_000 }))
}

async function writeBackend($: EngineInterface, backend: Backend, doc: Record<string, unknown>): Promise<void> {
  const text = JSON.stringify(doc)
  if (backend.kind === 'keychain') return keychainWrite($, backend.service, backend.user, text)
  await $.fs.write(backend.path, text)
  await restrict($, backend.path)
}

function accountUuid(oauthAccount: Record<string, unknown> | null): string | null {
  return str(oauthAccount?.accountUuid)
}

// What tells two saved accounts apart: the account and the organization it signed in for.
// One person (one accountUuid, one email) can be in several organizations – a personal plan
// and a team – each with its own login and limits.
function keyOf(oauthAccount: Record<string, unknown> | null): string | null {
  const uuid = accountUuid(oauthAccount)
  return uuid ? `${uuid}|${str(oauthAccount?.organizationUuid) ?? ''}` : null
}

function keyOfFile(a: AccountFile): string {
  return `${a.accountUuid}|${a.organizationUuid ?? ''}`
}

// ---------------------------------------------------------------- The account store

function describe(a: AccountFile): string {
  const who = [a.email, a.displayName, a.organizationName].filter(Boolean).join(' · ')
  return a.label ? `${a.label} (${who || a.accountUuid})` : who || a.accountUuid
}

function shortName(a: AccountFile): string {
  return a.label || a.email || a.displayName || a.accountUuid.slice(0, 8)
}

async function listAccounts($: EngineInterface): Promise<Account[]> {
  const dir = await storeDir($)
  if (!dir || !(await safe(() => $.fs.exists(dir)))) return []
  const entries = (await safe(() => $.fs.list(dir))) ?? []
  const out: Account[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    const path = `${dir}/${e.name}`
    try {
      const data = JSON.parse(String(await $.fs.read(path)))
      if (isObject(data) && typeof data.accountUuid === 'string' && isObject(data.claudeAiOauth)) {
        out.push({ path, data: data as unknown as AccountFile })
      }
    } catch {
      // not one of ours, or broken: left alone
    }
  }
  return out.sort((a, b) => a.data.savedAt.localeCompare(b.data.savedAt))
}

async function writeAccount($: EngineInterface, account: Account): Promise<void> {
  await $.fs.write(account.path, `${JSON.stringify(account.data, null, 2)}\n`)
  await restrict($, account.path)
}

function fileFor(dir: string, key: string): string {
  return `${dir}/${key.replace(/\|$/, '').replace(/[^A-Za-z0-9_-]/g, '_')}.json`
}

function accountFrom(oauthAccount: Record<string, unknown>, tokens: OAuthTokens, at: string, before?: AccountFile): AccountFile {
  return {
    version: 1,
    accountUuid: accountUuid(oauthAccount) as string,
    label: before?.label ?? null,
    email: str(oauthAccount.emailAddress) ?? before?.email ?? null,
    displayName: str(oauthAccount.displayName) ?? before?.displayName ?? null,
    organizationName: str(oauthAccount.organizationName) ?? before?.organizationName ?? null,
    organizationUuid: str(oauthAccount.organizationUuid) ?? before?.organizationUuid ?? null,
    subscriptionType: str(tokens.subscriptionType) ?? before?.subscriptionType ?? null,
    savedAt: before?.savedAt ?? at,
    updatedAt: at,
    oauthAccount,
    claudeAiOauth: tokens,
    ...(before?.lastUsage ? { lastUsage: before.lastUsage } : {}),
    ...(before?.autoSwitch ? { autoSwitch: true } : {}),
    ...(before?.modelBlocked ? { modelBlocked: true } : {}),
  }
}

function sameTokens(a: OAuthTokens, b: OAuthTokens): boolean {
  return a.accessToken === b.accessToken || (Boolean(a.refreshToken) && a.refreshToken === b.refreshToken)
}

// Who the server says a token belongs to (GET /api/oauth/profile); null where it does not
// answer. Never renews anything.
async function profileOwner($: EngineInterface, tokens: OAuthTokens): Promise<string | null> {
  if (expired(tokens, await now($))) return null
  const r = await safe(() => fetchJson($, `${API}/api/oauth/profile`, { headers: usageHeaders(tokens.accessToken) }))
  if (!r?.ok) return null
  try {
    const body = JSON.parse(r.text)
    const uuid = str(body?.account?.uuid)
    return uuid ? `${uuid}|${str(body?.organization?.uuid) ?? ''}` : null
  } catch {
    return null
  }
}

// Whose tokens the login holds. The tokens (keychain or .credentials.json) and the account
// record (~/.claude.json) are two places: a Claude Code that still held the old record can
// write it back after a switch, and saving by the record alone would then file one
// account's tokens under another. Tokens that are a saved account's own pair are its; new
// ones (Claude Code renewed them, or a new login) are asked of the server.
async function ownerOf($: EngineInterface, tokens: OAuthTokens, recordUuid: string, accounts: Account[]): Promise<string | null> {
  const known = accounts.find(a => sameTokens(a.data.claudeAiOauth, tokens))
  if (known) return keyOfFile(known.data)
  return (await profileOwner($, tokens)) ?? recordUuid
}

// Puts the owner's account record back into ~/.claude.json, so the record matches the
// tokens again (and CTM, which reads the record, sees the right account).
async function healRecord($: EngineInterface, live: Live, owner: Account): Promise<void> {
  const config = await readGlobalConfig($, live.configPath)
  config.oauthAccount = owner.data.oauthAccount
  await $.fs.write(live.configPath, `${JSON.stringify(config, null, 2)}\n`)
  live.oauthAccount = owner.data.oauthAccount
  toast($, `Account: ~/.claude.json named another account than the login – set back to ${shortName(owner.data)}`)
}

// Writes the live login into its account's file: the tokens Claude Code holds now (it
// renews them now and then) and its oauthAccount. A new account is saved only with
// `create` (or autoSave). Answers the account, or null where nothing was saved.
async function syncLive($: EngineInterface, { create = false, label }: { create?: boolean; label?: string } = {}): Promise<{ account: Account | null; live: Live; created: boolean }> {
  const live = await readLive($)
  let uuid = keyOf(live.oauthAccount)
  if (!uuid || !live.tokens || !live.oauthAccount) return { account: null, live, created: false }
  const accounts = await listAccounts($)
  const recorded = accounts.find(a => keyOfFile(a.data) === uuid)
  if (!recorded || !sameTokens(recorded.data.claudeAiOauth, live.tokens)) {
    const owner = await ownerOf($, live.tokens, uuid, accounts)
    if (owner && owner !== uuid) {
      const saved = accounts.find(a => keyOfFile(a.data) === owner)
      // Tokens of an account never saved, under another's record: nothing to file them under.
      if (!saved) return { account: null, live, created: false }
      await healRecord($, live, saved)
      uuid = owner
    }
  }
  const existing = accounts.find(a => keyOfFile(a.data) === uuid)
  if (!existing && !create && !autoSave) return { account: null, live, created: false }
  const dir = await storeDir($)
  if (!dir) return { account: null, live, created: false }
  const at = new Date(await now($)).toISOString()
  const before = existing?.data
  const data = accountFrom(live.oauthAccount, live.tokens, at, before)
  if (label !== undefined) {
    const clash = labelClash(accounts, label || null, uuid)
    if (clash) throw new Error(clash)
    data.label = label || null
  }
  if (!data.label) data.label = autoLabel(accounts, data)
  const unchanged =
    before &&
    before.label === data.label &&
    JSON.stringify(before.claudeAiOauth) === JSON.stringify(data.claudeAiOauth) &&
    JSON.stringify(before.oauthAccount) === JSON.stringify(data.oauthAccount) &&
    !before.needsLogin
  if (unchanged) return { account: existing, live, created: false }
  const account = { path: existing?.path ?? fileFor(dir, uuid), data }
  await writeAccount($, account)
  return { account, live, created: !existing }
}

// A short name of its own for an account saved without one: the first name, else what
// stands before the @, lower case; "alex", then "alex-2", "alex-3" where it is taken.
function autoLabel(accounts: Account[], data: AccountFile): string {
  const source = data.displayName?.split(/\s+/)[0] || data.email?.split('@')[0] || data.accountUuid.slice(0, 8)
  const base = source.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
  const key = keyOfFile(data)
  const taken = new Set(accounts.filter(a => keyOfFile(a.data) !== key).map(a => a.data.label?.toLowerCase()))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

// Gives every saved account without a label one (older files, accounts saved elsewhere).
async function ensureLabels($: EngineInterface, accounts: Account[]): Promise<void> {
  for (const a of accounts) {
    if (a.data.label) continue
    a.data.label = autoLabel(accounts, a.data)
    await safe(() => writeAccount($, a))
  }
}

// On the alwaysAsk list (the userConfig option, which managed settings can pin): the model
// must ask before switching there, whatever the account's own setting says.
function mustAsk(a: AccountFile): boolean {
  const email = a.email?.toLowerCase() ?? ''
  const org = a.organizationName?.toLowerCase() ?? ''
  const orgId = a.organizationUuid?.toLowerCase() ?? ''
  return alwaysAsk.some(x => (x.startsWith('@') ? email.endsWith(x) : x === email || x === org || x === orgId))
}

// A label names one account: refused where another saved account carries it already.
function labelClash(accounts: Account[], label: string | null, key: string): string | null {
  if (!label) return null
  const other = accounts.find(a => keyOfFile(a.data) !== key && a.data.label?.toLowerCase() === label.toLowerCase())
  return other ? `the label "${label}" is taken by ${describe(other.data)} – pick another, or relabel that one first` : null
}

// "work", an email, a name, an organization, a uuid (or its start), or the number the list shows.
function findAccount(accounts: Account[], query: string): Account | { error: string } {
  const q = query.trim().toLowerCase()
  if (!q) return { error: 'name the account: its label, email, name, number in the list, or uuid' }
  if (/^\d+$/.test(q)) {
    const a = accounts[Number(q) - 1]
    if (a) return a
  }
  const fields = (a: AccountFile) => [a.label, a.email, a.displayName, a.organizationName, a.accountUuid].filter((x): x is string => Boolean(x)).map(x => x.toLowerCase())
  const byKey = accounts.find(a => keyOfFile(a.data).toLowerCase() === q)
  if (byKey) return byKey
  // A label names one account: it wins over a name or email that others share.
  const labelled = accounts.find(a => a.data.label?.toLowerCase() === q)
  if (labelled) return labelled
  const exact = accounts.filter(a => fields(a.data).includes(q))
  if (exact.length === 1) return exact[0]!
  const loose = accounts.filter(a => fields(a.data).some(f => f.startsWith(q) || f.includes(q)))
  if (exact.length === 0 && loose.length === 1) return loose[0]!
  const hits = exact.length > 1 ? exact : loose
  if (hits.length > 1) return { error: `"${query}" fits ${hits.length} accounts: ${hits.map(a => describe(a.data)).join('; ')} – be more precise` }
  return { error: `no saved account fits "${query}"${accounts.length ? ` (saved: ${accounts.map(a => shortName(a.data)).join(', ')})` : ' – none is saved yet'}` }
}

// ---------------------------------------------------------------- Usage and tokens

type Fetched = { status: number; ok: boolean; text: string }

async function fetchJson($: EngineInterface, url: string, init: Parameters<EngineInterface['http']['fetch']>[1]): Promise<Fetched> {
  const r = await $.http.fetch(url, init)
  return { status: r.status, ok: r.ok, text: r.text }
}

function parseUsage(text: string, at: number): Usage | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(body)) return null
  const limits: Limit[] = []
  for (const kind of ['five_hour', 'seven_day'] as const) {
    const x = body[kind]
    if (!isObject(x) || typeof x.utilization !== 'number' || !Number.isFinite(x.utilization)) continue
    const reset = typeof x.resets_at === 'string' && Number.isFinite(Date.parse(x.resets_at)) ? new Date(Date.parse(x.resets_at)).toISOString() : null
    limits.push({ kind, percent: x.utilization, resetsAt: reset })
  }
  return { at, limits }
}

class AuthError extends Error {}

// Renews an inactive account's tokens with its refresh token and saves the new pair at
// once – the old refresh token is spent by then.
async function renew($: EngineInterface, account: Account): Promise<void> {
  const t = account.data.claudeAiOauth
  if (!t.refreshToken) throw new AuthError('its token ran out and it has no refresh token')
  const body: Record<string, unknown> = { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: CLIENT_ID }
  if (Array.isArray(t.scopes) && t.scopes.length) body.scope = t.scopes.join(' ')
  const r = await fetchJson($, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) {
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      account.data.needsLogin = true
      await safe(() => writeAccount($, account))
      throw new AuthError(`its refresh token was refused (HTTP ${r.status}) – sign in with it again (/login), then /account save`)
    }
    throw new Error(`renewing its token failed (HTTP ${r.status})`)
  }
  const answer = JSON.parse(r.text)
  if (!isObject(answer) || typeof answer.access_token !== 'string') throw new Error('renewing its token gave no access token')
  const at = await now($)
  account.data.claudeAiOauth = {
    ...t,
    accessToken: answer.access_token,
    refreshToken: typeof answer.refresh_token === 'string' ? answer.refresh_token : t.refreshToken,
    expiresAt: at + (typeof answer.expires_in === 'number' ? answer.expires_in : 3600) * 1000,
    ...(typeof answer.scope === 'string' ? { scopes: answer.scope.split(' ').filter(Boolean) } : {}),
  }
  delete account.data.needsLogin
  account.data.updatedAt = new Date(at).toISOString()
  await writeAccount($, account)
}

function expired(t: OAuthTokens, at: number): boolean {
  return typeof t.expiresAt === 'number' && t.expiresAt - RENEW_MARGIN_MS <= at
}

function usageHeaders(token?: string): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'anthropic-beta': OAUTH_BETA,
    'Content-Type': 'application/json',
    'User-Agent': 'claude-account-switcher',
  }
}

// The account's limits from the server. The active account is read with the session's
// own credential (or the token Claude Code holds) and never renewed here.
async function fetchUsage($: EngineInterface, account: Account, active: Live | null): Promise<Usage> {
  const url = `${API}/api/oauth/usage`
  const at = await now($)
  if (active) {
    const auth = await safe(() => $.session.authorize())
    if (auth?.kind === 'bearer') {
      const r = await safe(() => fetchJson($, url, { headers: usageHeaders(), auth: auth.handle }))
      const u = r?.ok ? parseUsage(r.text, at) : null
      if (u) return u
    }
    const t = active.tokens
    if (!t || expired(t, at)) throw new Error('the active account’s token is about to be renewed by Claude Code – try again in a moment (CTM shows its limits meanwhile)')
    const r = await fetchJson($, url, { headers: usageHeaders(t.accessToken) })
    if (!r.ok) throw new Error(`the server answered HTTP ${r.status}`)
    const u = parseUsage(r.text, at)
    if (!u) throw new Error('the answer could not be read')
    return u
  }
  if (expired(account.data.claudeAiOauth, at)) await renew($, account)
  let r = await fetchJson($, url, { headers: usageHeaders(account.data.claudeAiOauth.accessToken) })
  if (r.status === 401) {
    await renew($, account)
    r = await fetchJson($, url, { headers: usageHeaders(account.data.claudeAiOauth.accessToken) })
  }
  if (r.status === 401 || r.status === 403) throw new AuthError(`the server refused its token (HTTP ${r.status})`)
  if (!r.ok) throw new Error(r.status === 429 ? 'the server answered 429 (asked too often) – try again in a few minutes' : `the server answered HTTP ${r.status}`)
  const u = parseUsage(r.text, at)
  if (!u) throw new Error('the answer could not be read')
  return u
}

type Reading = { account: Account; usage: Usage | null; error: string | null; fresh: boolean }

// Reads the account's limits unless a young enough reading is at hand; saves them in its
// file. Never throws.
async function usageOf($: EngineInterface, account: Account, live: Live | null, force: boolean): Promise<Reading> {
  const at = await now($)
  const last = account.data.lastUsage
  const tried = lastTried.get(keyOfFile(account.data)) ?? Number.NEGATIVE_INFINITY
  const young = last && at - last.at < USAGE_FRESH_MS
  if ((young && !force) || at - tried < USAGE_DEMAND_GAP_MS) {
    return { account, usage: last ?? null, error: last ? null : 'not read yet', fresh: false }
  }
  lastTried.set(keyOfFile(account.data), at)
  try {
    const usage = await fetchUsage($, account, live)
    account.data.lastUsage = usage
    await safe(() => writeAccount($, account))
    return { account, usage, error: null, fresh: true }
  } catch (err) {
    return { account, usage: last ?? null, error: errorText(err), fresh: false }
  }
}

function limitOf(u: Usage | null | undefined, kind: LimitKind): Limit | undefined {
  return u?.limits.find(l => l.kind === kind)
}

// A limit whose window has reset since the reading counts as empty.
function percentNow(l: Limit | undefined, at: number): number | null {
  if (!l) return null
  if (l.resetsAt && Date.parse(l.resetsAt) <= at) return 0
  return l.percent
}

function isFull(u: Usage | null, at: number): boolean {
  return (['five_hour', 'seven_day'] as const).some(k => (percentNow(limitOf(u, k), at) ?? 0) >= FULL_AT[k])
}

function fmtLimits(u: Usage | null, at: number): string {
  if (!u) return 'limits unknown'
  const parts: string[] = []
  for (const [kind, name] of [['five_hour', '5-hour'], ['seven_day', '7-day']] as const) {
    const l = limitOf(u, kind)
    if (!l) continue
    const reset = l.resetsAt ? Date.parse(l.resetsAt) : null
    if (reset !== null && reset <= at) parts.push(`${name} 0% (window reset since the reading)`)
    else parts.push(`${name} ${fmtPercent(l.percent)}${reset !== null ? ` (resets in ${fmtSpan(at, reset)})` : ''}`)
  }
  if (parts.length === 0) return 'no 5-hour / 7-day limits reported'
  return `${parts.join(' · ')} · read ${at - u.at < MINUTE ? 'just now' : `${fmtSpan(u.at, at)} ago`}`
}

// The account with the most room: neither limit near full, the lowest 5-hour use first.
function bestOther(readings: Reading[], activeUuid: string | null, at: number): Reading | null {
  const candidates = readings.filter(
    r => keyOfFile(r.account.data) !== activeUuid && r.usage && !isFull(r.usage, at) && !r.account.data.needsLogin && !r.account.data.modelBlocked,
  )
  candidates.sort((a, b) => {
    const p = (r: Reading, k: LimitKind) => percentNow(limitOf(r.usage, k), at) ?? 0
    return p(a, 'five_hour') - p(b, 'five_hour') || p(a, 'seven_day') - p(b, 'seven_day')
  })
  return candidates[0] ?? null
}

// ---------------------------------------------------------------- Levels and the settings pane

type Level = AccountRow['level']

function levelOf(a: AccountFile): Level {
  return a.modelBlocked ? 'block' : a.autoSwitch && !mustAsk(a) ? 'allow' : 'ask'
}

// Sets what the model may do for one account; refuses `allow` on the alwaysAsk list.
// Answers what changed, in a sentence, or the refusal.
async function setLevel($: EngineInterface, account: Account, level: Level): Promise<{ text: string; refused?: true }> {
  if (level === 'allow' && mustAsk(account.data)) {
    return {
      refused: true,
      text:
        `${describe(account.data)} is on the always-ask list (option alwaysAsk): the model must ask you before it ` +
        'switches there, and that cannot be lifted here. Change the option (or, if your organization set it, ask them).',
    }
  }
  account.data.autoSwitch = level === 'allow'
  account.data.modelBlocked = level === 'block'
  await writeAccount($, account)
  return {
    text:
      level === 'allow'
        ? `The model may now switch to ${describe(account.data)} on its own.`
        : level === 'ask'
          ? `The model now asks you before it switches to ${describe(account.data)}.`
          : `The model may no longer switch to ${describe(account.data)} at all, not even by asking. You still can (/account switch).`,
  }
}

// Enter on a row: on to the next level, past `allow` where asking is enforced.
function nextLevel(level: Level, enforced: boolean): Level {
  const order: Level[] = enforced ? ['ask', 'block'] : ['allow', 'ask', 'block']
  return order[(order.indexOf(level) + 1) % order.length] ?? 'ask'
}

const LEVEL_TEXT: Record<Level, string> = {
  allow: 'switch freely',
  ask: 'ask first',
  block: 'never',
}

const PANE = 'account-switcher'
const rows = atom({ plugin: 'account-switcher', key: 'rows' } as const, [] as AccountRow[], { shape: 'rows-1' })

// What the pane draws, from the account files (their last readings: no server request).
async function refreshRows($: EngineInterface): Promise<void> {
  const accounts = await listAccounts($)
  await ensureLabels($, accounts)
  const live = await safe(() => readLive($))
  const activeKey = keyOf(live?.oauthAccount ?? null)
  const at = await now($)
  const list: AccountRow[] = accounts.map(a => ({
    key: keyOfFile(a.data),
    name: shortName(a.data),
    who: [a.data.email, a.data.organizationName, a.data.subscriptionType].filter(Boolean).join(' · '),
    level: levelOf(a.data),
    enforced: mustAsk(a.data),
    active: keyOfFile(a.data) === activeKey,
    limits: (a.data.lastUsage ? fmtLimits(a.data.lastUsage, at) : 'limits not read yet') + (a.data.lastUsage && isFull(a.data.lastUsage, at) ? ' · FULL' : ''),
  }))
  await update($, rows, () => list)
}

async function openPane($: EngineInterface): Promise<void> {
  await refreshRows($)
  await $.ui.open({ id: PANE, title: 'Accounts', focus: true, closeOnEscape: true })
}

// ---------------------------------------------------------------- Guarding the store

const STORE_DENIED =
  'Account switcher: the account store holds the saved logins (tokens) and the user\'s allow list – you may not ' +
  'read or change it directly. Use mcp__account-switcher__accounts / __switch / __save; the user has /account.'

function norm(p: string): string {
  return trimSlash(p.replace(/\\/g, '/')).toLowerCase()
}

// Where a path really leads (links and .. resolved), or the path as written.
async function realOf($: EngineInterface, p: string): Promise<string> {
  const stat = await safe(() => $.fs.stat(p, { resolve: true }))
  if (stat?.realPath) return stat.realPath
  // Not there yet (a Write): place it by its folder.
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (cut > 0) {
    const folder = await safe(() => $.fs.stat(p.slice(0, cut), { resolve: true }))
    if (folder?.realPath) return `${folder.realPath}/${p.slice(cut + 1)}`
  }
  return p
}

async function insideStore($: EngineInterface, p: string, dir: string): Promise<boolean> {
  const store = norm(await realOf($, dir))
  const plain = norm(dir)
  for (const candidate of [norm(p), norm(await realOf($, p))]) {
    for (const root of [store, plain]) if (candidate === root || candidate.startsWith(`${root}/`)) return true
  }
  return false
}

function mentionsStore(command: string, dir: string): boolean {
  const c = command.replace(/\\/g, '/').toLowerCase()
  return c.includes('account-switcher/accounts') || c.includes(norm(dir))
}

// ---------------------------------------------------------------- Settings

async function ensureSettings($: EngineInterface): Promise<Settings> {
  if (settings) return settings
  const stored = await safe(() => $.store.get(STORE_SETTINGS))
  settings = isObject(stored) ? { ...(stored as Settings) } : {}
  return settings
}

async function modelMaySwitch($: EngineInterface): Promise<boolean> {
  return (await ensureSettings($)).allowModelSwitch ?? allowModelSwitchDefault
}

async function setModelMaySwitch($: EngineInterface, value: boolean | null): Promise<void> {
  const s = { ...(await ensureSettings($)) }
  if (value === null) delete s.allowModelSwitch
  else s.allowModelSwitch = value
  settings = s
  await safe(() => $.store.set(STORE_SETTINGS, s))
}

// ---------------------------------------------------------------- What the tools answer

async function overview($: EngineInterface, { refresh }: { refresh: boolean }): Promise<string> {
  let synced: Awaited<ReturnType<typeof syncLive>> | null = null
  let syncError: string | null = null
  try {
    synced = await serial(() => syncLive($))
  } catch (err) {
    syncError = errorText(err)
  }
  const live = synced?.live ?? null
  const activeUuid = keyOf(live?.oauthAccount ?? null)
  const accounts = await listAccounts($)
  await ensureLabels($, accounts)
  const at = await now($)
  const readings: Reading[] = []
  for (const a of accounts) {
    const isActive = keyOfFile(a.data) === activeUuid
    readings.push(await usageOf($, a, isActive ? live : null, refresh))
  }
  const lines: string[] = []
  const active = accounts.find(a => keyOfFile(a.data) === activeUuid)
  lines.push(
    `Accounts: ${accounts.length} saved · active: ${
      active ? describe(active.data) : activeUuid ? `${str(live?.oauthAccount?.emailAddress) ?? accountUuid(live?.oauthAccount ?? null)} (not saved – /account save)` : 'none (not signed in with a claude.ai account)'
    }`,
  )
  readings.forEach((r, i) => {
    const d = r.account.data
    // Every line starts with a glyph: Claude Code shifts lines that start with spaces.
    const mark = keyOfFile(d) === activeUuid ? '▶' : '○'
    const facts = [d.email, d.displayName, d.organizationName, d.subscriptionType].filter(Boolean).join(' · ')
    const allow = d.modelBlocked
      ? 'model may NOT switch here'
      : mustAsk(d)
        ? 'model asks first (enforced)'
        : d.autoSwitch
          ? 'model may switch here'
          : 'model asks first'
    lines.push(`${mark} ${i + 1}. ${d.label ? `${d.label} – ` : ''}${facts || d.accountUuid} · ${allow}`)
    let detail = `└ ${fmtLimits(r.usage, at)}`
    if (r.usage && isFull(r.usage, at)) detail += ' · FULL'
    if (d.needsLogin) detail += ' · NEEDS A NEW LOGIN (its refresh token was refused)'
    else if (r.error && r.error !== 'not read yet') detail += ` · could not read anew: ${r.error}`
    lines.push(detail)
  })
  if (syncError) lines.push(`(Could not read the current login: ${syncError})`)
  const best = bestOther(readings, activeUuid, at)
  const may = await modelMaySwitch($)
  lines.push(
    best
      ? `Most room elsewhere: ${readings.indexOf(best) + 1}. ${shortName(best.account.data)} – ${fmtLimits(best.usage, at)}`
      : accounts.length > 1
        ? 'No other account with room known.'
        : 'Only one account saved: switching needs another (sign in with it via /login – it is saved on its own – then come back).',
  )
  lines.push(
    may
      ? `You may switch on your own to accounts marked "model may switch here" (${T_SWITCH}${cooldownMs > 0 ? `, at most every ${cooldownMs / MINUTE} min` : ''}); ` +
          `to one marked "model asks first", ${T_SWITCH} puts the switch to the user in a dialog and switches only if they confirm; ` +
          'to one marked "model may NOT switch here" never (only the user can, with /account switch).'
      : 'The user has NOT allowed you to switch on your own: suggest a switch to them instead (/account switch <name>).',
  )
  return lines.join('\n')
}

// Where this machine keeps what: for /account where, to check a new system by hand.
async function whereReport($: EngineInterface): Promise<string> {
  const lines: string[] = []
  const windows = await isWindows($)
  const mac = await isMac($)
  lines.push(`System: ${windows ? 'Windows' : mac ? 'macOS' : 'Linux / other Unix'}`)
  lines.push(`Home: ${(await home($)) ?? '(none – neither HOME nor USERPROFILE is set)'}`)
  lines.push(`Claude config dir: ${(await configDir($)) ?? '?'}`)
  if (mac) lines.push(`Keychain item looked for: "${await keychainService($)}" (account "${await keychainUser($)}")`)
  lines.push(`Credentials file${mac ? ' (used where the keychain has no item)' : ''}: ${(await credentialsFile($)) ?? '?'}`)
  lines.push(`Account record: ${(await globalConfigPath($)) ?? '?'} (oauthAccount – CTM reads it too)`)
  lines.push(`Account store: ${(await storeDir($)) ?? '?'}`)
  try {
    const live = await readLive($)
    lines.push(
      `Login found in: ${live.backend.kind === 'keychain' ? `the macOS keychain ("${live.backend.service}")` : live.backend.path}` +
        (live.unreadable
          ? ' – but it is BROKEN (no readable JSON, cut short by a failed write): /account switch <a saved account> or /login repairs it'
          : live.tokens
            ? ''
            : ' – but it holds no claude.ai tokens (an API key, a cloud provider, or not signed in)'),
    )
    const uuid = keyOf(live.oauthAccount)
    lines.push(
      `Account record names: ${uuid ? `${str(live.oauthAccount?.emailAddress) ?? '?'} (account ${accountUuid(live.oauthAccount)}, organization ${str(live.oauthAccount?.organizationUuid) ?? '?'})` : 'no account'}`,
    )
    if (live.tokens && uuid) {
      const accounts = await listAccounts($)
      const saved = accounts.find(a => keyOfFile(a.data) === uuid)
      lines.push(
        saved
          ? `Saved in the store: yes – ${describe(saved.data)}, last written ${saved.data.updatedAt} (${saved.path})`
          : `Saved in the store: not yet – ${autoSave ? 'it is saved with the next /account or within 5 min (autoSave)' : 'autoSave is off: /account save'}`,
      )
      lines.push(`Accounts in the store: ${accounts.length}${accounts.length ? ` (${accounts.map(a => shortName(a.data)).join(', ')})` : ''}`)
      const owner = await ownerOf($, live.tokens, uuid, accounts)
      const ownerFile = accounts.find(a => keyOfFile(a.data) === owner)
      lines.push(
        owner === uuid
          ? 'Tokens and record agree.'
          : `Tokens belong to ${ownerFile ? describe(ownerFile.data) : `another account or organization (${owner})`} – the record names another (the next sync sets it right where that one is saved).`,
      )
    }
  } catch (err) {
    lines.push(`Could not read the login: ${errorText(err)}`)
  }
  return lines.join('\n')
}

type SwitchBy = { by: 'model' | 'person'; reason?: string }

async function switchTo($: EngineInterface, query: string, how: SwitchBy): Promise<string> {
  return serial(async () => {
    const { account: current, live } = await syncLive($)
    const fromUuid = keyOf(live.oauthAccount)
    const accounts = await listAccounts($)
    await ensureLabels($, accounts)
    const found = findAccount(accounts, query)
    if ('error' in found) throw new Error(found.error)
    const target = found
    if (keyOfFile(target.data) === fromUuid) return `Already on ${describe(target.data)} – nothing to switch.`
    // A login with no tokens in it (signed out, or broken) has nothing to lose: switching repairs it.
    if (fromUuid && !current && live.tokens) {
      throw new Error(
        `the account signed in now (${str(live.oauthAccount?.emailAddress) ?? fromUuid}) is not saved, and autoSave is off – its login would be lost. Save it first (/account save, or ${T_SAVE}).`,
      )
    }
    // A target whose login no longer works would leave the session signed out: renew and
    // read it first (this also renews a token that ran out, and saves the new pair).
    let reading: Reading | null = null
    try {
      const usage = await fetchUsage($, target, null)
      target.data.lastUsage = usage
      await safe(() => writeAccount($, target))
      reading = { account: target, usage, error: null, fresh: true }
    } catch (err) {
      if (err instanceof AuthError) throw new Error(`${describe(target.data)} cannot be signed in: ${err.message}`)
      reading = { account: target, usage: target.data.lastUsage ?? null, error: errorText(err), fresh: false }
      if (expired(target.data.claudeAiOauth, await now($))) {
        throw new Error(`${describe(target.data)}: its token ran out and could not be renewed (${errorText(err)}) – try again later`)
      }
    }
    // The login: the target's tokens, everything else in the document as it was.
    const previousDoc = live.doc
    const doc = { ...(live.doc ?? {}), claudeAiOauth: target.data.claudeAiOauth }
    try {
      await writeBackend($, live.backend, doc)
    } catch (err) {
      // A write that failed half-way may have left a broken login: put the old one back.
      const restored = previousDoc ? await safe(() => writeBackend($, live.backend, previousDoc).then(() => true)) : false
      throw new Error(
        `could not write the login (${errorText(err)}) – ` +
          (restored ? 'the old login is back in place, nothing changed' : 'and the old login could not be put back: sign in again with /login'),
      )
    }
    try {
      const config = await readGlobalConfig($, live.configPath)
      config.oauthAccount = target.data.oauthAccount
      await $.fs.write(live.configPath, `${JSON.stringify(config, null, 2)}\n`)
    } catch (err) {
      // Put the old login back, or tokens and account record would disagree.
      if (previousDoc) await safe(() => writeBackend($, live.backend, previousDoc))
      throw new Error(`could not update ${live.configPath} (${errorText(err)}) – the old login is back in place`)
    }
    const after = await readLive($)
    if (keyOf(after.oauthAccount) !== keyOfFile(target.data) || after.tokens?.accessToken !== target.data.claudeAiOauth.accessToken) {
      throw new Error('the switch did not hold – something else wrote the login at the same time; check with /account')
    }
    const at = await now($)
    if (how.by === 'model') lastModelSwitchAt = at
    // A Claude Code session that still held the old record may write it back soon after:
    // look again a few times (syncLive puts the right record back).
    for (const ms of [10_000, 30_000, 60_000, 120_000]) $.clock.after(ms, () => void safe(() => serial(() => syncLive($))))
    const from = current ? describe(current.data) : 'no saved account'
    toast($, `Account: switched to ${shortName(target.data)}${how.by === 'model' ? ' (by the model)' : ''}`)
    void safe(() => refreshRows($)) // the settings pane, where it is open
    return [
      `Switched from ${from} to ${describe(target.data)}.${how.reason ? ` Reason: ${how.reason}` : ''}`,
      `Its limits: ${fmtLimits(reading?.usage ?? null, at)}${reading?.error ? ` (could not read anew: ${reading.error})` : ''}.`,
      'Claude Code uses the new login from its next request on. Every Claude Code session on this machine that shares this config dir now runs on it too.',
    ].join('\n')
  })
}

const BRIEFING = [
  '# Account switcher',
  'The user keeps several Claude accounts; the account-switcher plugin can switch this session (and every Claude Code session on this machine) between them in seconds, without a restart.',
  `- ${T_ACCOUNTS}: the saved accounts (label, email, name, organization, plan), which is active, and each one's 5-hour and 7-day limits – read from the server without switching; refresh=true reads them anew.`,
  `- ${T_SWITCH}: switches to another saved account from your next request on (needs "account" and a short "reason"). Only while the user lets you – ${T_ACCOUNTS} says whether. To an account on the user's allow list ("model may switch here") it switches at once, not more often than the cooldown; to one marked "model asks first" it first asks the user in a dialog and switches only if they confirm – a "no" is final for now, do not ask again right away; to one marked "model may NOT switch here" you may not switch at all – do not try or ask, suggest it to the user if it is the only one with room.`,
  `- ${T_SAVE}: saves the account signed in now (normally that happens on its own).`,
  '- When a limit runs high (CTM\'s blocks show the active account\'s limits; past a pause mark they ask you to pause), check the other accounts first: if one has room and you may switch, switch to it at a clean point and carry on instead of pausing. Prefer the account with the most room that does not reset soon anyway; do not switch back and forth.',
  '- If you may not switch on your own, tell the user which account has room and that /account switch <name> moves there.',
].join('\n')

// ---------------------------------------------------------------- Registration

export const register: Register = (on, options) => {
  allowModelSwitchDefault = options.allowModelSwitch !== false
  cooldownMs = Math.max(0, Number(options.switchCooldownMinutes ?? 5)) * MINUTE
  autoSave = options.autoSave !== false
  configuredStoreDir = String(options.storeDir ?? '').trim()
  configuredKeychain = String(options.keychainService ?? '').trim()
  alwaysAsk = String(options.alwaysAsk ?? '')
    .split(/[,;\n]/)
    .map(x => x.trim().toLowerCase())
    .filter(Boolean)
  settings = null
  lastModelSwitchAt = Number.NEGATIVE_INFINITY
  lastTried = new Map()
  syncTimer = null
  busy = Promise.resolve()

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'accounts',
      description:
        'Account switcher: lists the saved Claude accounts – label, email, name, organization, plan, which is active – ' +
        'with each one\'s 5-hour and 7-day limits, read from the server without switching (no model request, no tokens), ' +
        'the account with the most room, and whether you may switch on your own. refresh=true reads the limits anew ' +
        '(otherwise a reading up to 3 min old is shown).',
      inputSchema: {
        type: 'object',
        properties: { refresh: { type: 'boolean', description: 'Read every account\'s limits anew from the server.' } },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'switch',
      description:
        'Account switcher: switches Claude Code to another saved account, effective from your next request – no restart. ' +
        'The current account\'s login is saved first. Only while the user lets you (see ' +
        `${T_ACCOUNTS}). An account on the user\'s allow list is switched to at once (at most every ${cooldownMs / MINUTE} min); ` +
        'for any other the user is asked in a dialog first and decides. Use it to go on working when the ' +
        'active account\'s limits run high and another has room. It switches every Claude Code session on this machine.',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string', description: 'The target: its label, email, name, number in the list, or uuid.' },
          reason: { type: 'string', description: 'Why, in a few words (shown to the user), e.g. "5-hour limit at 92%, work has 10%".' },
        },
        required: ['account', 'reason'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'save',
      description:
        'Account switcher: saves the account Claude Code is signed in with now to the account store (tokens, email, ' +
        'name, organization), optionally with a label. New logins are normally saved on their own.',
      inputSchema: {
        type: 'object',
        properties: { label: { type: 'string', description: 'A short name for it, e.g. "work" or "private".' } },
        additionalProperties: false,
      },
    })
    await safe(() =>
      $.command.register({
        name: 'account',
        description: 'Claude accounts: /account lists them with their limits · settings (a pane) · switch <name> · allow|ask|block <name> · save [label] · label <name> <label> · remove <name> · auto on|off · where',
        argumentHint: '[list|settings|switch|allow|ask|block|save|label|remove|auto|where] …',
      }),
    )
    await ensureSettings($)
    await safe(() => serial(() => syncLive($)))
    syncTimer?.cancel()
    // Claude Code renews the active account's tokens now and then: keep its file current,
    // so a switch away and back again finds a pair that still works.
    syncTimer = $.clock.every(SYNC_EVERY_MS, () => void safe(() => serial(() => syncLive($))))
    return next(e)
  })

  // /login replaces the login where Claude Code keeps it: save the account signed in so far
  // with the tokens it holds now first (they may be newer than its file), and the new one
  // once the login is through. The login dialog may outlast the command's run, so look again
  // a few times after it.
  on('command.run', { command: ['login', 'logout'] }, async ($, e, next) => {
    await safe(() => serial(() => syncLive($)))
    const r = await next(e)
    await safe(() => serial(() => syncLive($)))
    for (const ms of LOGIN_LOOKS_MS) $.clock.after(ms, () => void safe(() => serial(() => syncLive($))))
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await safe(() => serial(() => syncLive($)))
    if (e.reason !== 'clear') {
      syncTimer?.cancel()
      syncTimer = null
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: 'account-switcher:info', text: BRIEFING, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- The model's tools

  on('tool.call', { tool: T_ACCOUNTS }, async ($, e) => {
    const refresh = (e as unknown as { refresh?: unknown }).refresh === true
    return { result: await overview($, { refresh }) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Account switcher: could not read the accounts.' }))

  on('tool.call', { tool: T_SWITCH }, async ($, e) => {
    const input = e as unknown as { account?: unknown; reason?: unknown; agentId?: unknown }
    if (input.agentId) return { deny: 'Account switcher: only the main agent may switch accounts.' }
    if (!(await modelMaySwitch($))) {
      return {
        deny:
          'Account switcher: the user has not allowed you to switch accounts on your own. Tell them which account has room; ' +
          'they switch with /account switch <name> (or allow you with /account auto on).',
      }
    }
    const account = typeof input.account === 'string' ? input.account : ''
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (!reason) return { deny: 'Account switcher: give a short "reason" for the switch.' }
    const accounts = await listAccounts($)
    await ensureLabels($, accounts)
    const target = findAccount(accounts, account)
    if ('error' in target) return { deny: `Account switcher: ${target.error}` }
    if (target.data.modelBlocked) {
      return {
        deny:
          `Account switcher: the user has excluded ${describe(target.data)} from switches by you – you may not switch there, ` +
          `and do not ask for it. Only the user can switch there (/account switch ${shortName(target.data)}). ` +
          'Pick another account, or go on on the current one or pause as CTM asks.',
      }
    }
    if (target.data.autoSwitch && !mustAsk(target.data)) {
      const at = await now($)
      if (at - lastModelSwitchAt < cooldownMs) {
        return { deny: `Account switcher: you switched ${fmtSpan(lastModelSwitchAt, at)} ago – wait ${fmtSpan(at, lastModelSwitchAt + cooldownMs)} more (no switching back and forth).` }
      }
    } else {
      // Not on the allow list: the user decides, in a dialog this plugin opens – the
      // model cannot answer it, and no permission mode or classifier settles it.
      const live = await safe(() => readLive($))
      if (live && keyOf(live.oauthAccount) === keyOfFile(target.data)) return { result: `Already on ${describe(target.data)} – nothing to switch.` }
      const question = `Switch the Claude account to ${describe(target.data)}? Reason given: ${reason}`
      let answer: string | undefined
      try {
        answer = await $.ui.ask(question, {
          header: 'Account',
          options: [
            { label: 'Switch', description: 'Switch now; every Claude Code session on this machine follows.' },
            { label: 'Don’t switch', description: 'Stay on the current account.' },
          ],
        } as never)
      } catch {
        answer = undefined
      }
      if (answer !== 'Switch') {
        return {
          deny:
            `Account switcher: the user did not confirm the switch to ${describe(target.data)}${answer ? ` (answer: ${answer})` : ''}. ` +
            'Do not ask again for this right away; go on on the current account or pause as CTM asks.',
        }
      }
    }
    try {
      return { result: await switchTo($, keyOfFile(target.data), { by: 'model', reason }) }
    } catch (err) {
      return { deny: `Account switcher: ${errorText(err)}` }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Account switcher: the switch failed.' }))

  on('tool.call', { tool: T_SAVE }, async ($, e) => {
    const label = (e as unknown as { label?: unknown }).label
    try {
      const r = await serial(() => syncLive($, { create: true, ...(typeof label === 'string' ? { label: label.trim() } : {}) }))
      if (!r.account) return { deny: 'Account switcher: Claude Code is not signed in with a claude.ai account – nothing to save.' }
      return { result: `Saved ${describe(r.account.data)} to ${r.account.path}.` }
    } catch (err) {
      return { deny: `Account switcher: ${errorText(err)}` }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Account switcher: could not save the account.' }))

  // ---------------------------------------------------------------- The settings pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, rows)
    const change = (row: AccountRow) => async () => {
      const accounts = await listAccounts($)
      const account = accounts.find(a => keyOfFile(a.data) === row.key)
      if (!account) return refreshRows($)
      const r = await setLevel($, account, nextLevel(levelOf(account.data), mustAsk(account.data)))
      if (r.refused) toast($, r.text)
      await refreshRows($)
    }
    return (
      <Box flexDirection="column">
        <Text bold>What the model may do per account</Text>
        <Text dimColor>Tab / arrows: next account · Enter: change · Esc: close</Text>
        {list.length === 0 && <Text dimColor>No account saved yet – sign in with /login, it is saved on its own.</Text>}
        {list.map((row, i) => (
          <Box key={`row-${row.key}`} flexDirection="column" marginTop={1}>
            <Button key={row.key} plain autoFocus={i === 0 ? true : undefined} onPress={change(row)}>
              {row.active ? '▶ ' : '○ '}
              {row.name} <Text dimColor>{row.who}</Text>
              {'  '}
              <Text bold>[{LEVEL_TEXT[row.level]}{row.enforced && row.level === 'ask' ? ', enforced' : ''}]</Text>
            </Button>
            <Text dimColor>└ {row.limits}</Text>
          </Box>
        ))}
        <Text dimColor>switch freely: at once · ask first: a dialog asks you · never: only you can switch there</Text>
      </Box>
    )
  })

  // ---------------------------------------------------------------- The store is not the model's

  // The account files hold every saved login, and the allow list beside it: the model reads
  // and changes them only through this plugin. A file tool aimed into the store is refused,
  // and so is a shell command that names it (best effort: a command can name a path in many
  // ways; the file tools are checked by where the path really leads).
  on('tool.call', async ($, e, next) => {
    const dir = await storeDir($)
    if (!dir) return next(e)
    const input = e as unknown as Record<string, unknown>
    const paths = [input.file_path, input.notebook_path, input.path].filter((p): p is string => typeof p === 'string' && p !== '')
    for (const p of paths) if (await insideStore($, p, dir)) return { deny: STORE_DENIED }
    const command = typeof input.command === 'string' ? input.command : ''
    if (command && mentionsStore(command, dir)) return { deny: STORE_DENIED }
    return next(e)
  })

  // ---------------------------------------------------------------- /account

  on('command.run', { command: 'account' }, async ($, e) => {
    const args = e.args.trim()
    const [verb = 'list', ...rest] = args.split(/\s+/).filter(Boolean)
    const tail = rest.join(' ')
    const usage = 'Usage: /account [list|usage|settings|where] · /account allow|ask|block <name> · /account save [label] · /account switch <name> · /account label <name> <label> · /account remove <name> · /account auto on|off|default'
    try {
      switch (verb.toLowerCase()) {
        case 'list':
        case 'ls':
          return { text: await overview($, { refresh: false }) }
        case 'usage':
        case 'limits':
        case 'refresh':
          return { text: await overview($, { refresh: true }) }
        case 'save': {
          const r = await serial(() => syncLive($, { create: true, ...(tail ? { label: tail } : {}) }))
          if (!r.account) return { text: 'Not signed in with a claude.ai account – nothing to save.' }
          return { text: `${r.created ? 'Saved' : 'Updated'} ${describe(r.account.data)} (${r.account.path}).` }
        }
        case 'switch':
        case 'use': {
          if (!tail) return { text: usage }
          const text = await switchTo($, tail, { by: 'person' })
          return { text, context: [`The user switched the Claude account with /account.\n${text}`] }
        }
        case 'label':
        case 'name': {
          const [who = '', ...labelParts] = rest
          const accounts = await listAccounts($)
          const found = findAccount(accounts, who)
          if ('error' in found) return { text: found.error }
          const label = labelParts.join(' ').trim() || null
          const clash = labelClash(accounts, label, keyOfFile(found.data))
          if (clash) return { text: clash }
          found.data.label = label
          await writeAccount($, found)
          return { text: `${found.data.label ? 'Labelled' : 'Label removed:'} ${describe(found.data)}.` }
        }
        case 'remove':
        case 'rm':
        case 'forget': {
          const accounts = await listAccounts($)
          const found = findAccount(accounts, tail)
          if ('error' in found) return { text: found.error }
          const live = await safe(() => readLive($))
          if (live && keyOf(live.oauthAccount) === keyOfFile(found.data) && autoSave) {
            return { text: `${describe(found.data)} is the active account and would be saved again at once (autoSave). Switch away first.` }
          }
          const argv = (await isWindows($)) ? ['cmd', '/c', 'del', '/f', '/q', found.path.replace(/\//g, '\\')] : ['rm', '-f', found.path]
          const r = await $.process.run(argv, { timeoutMs: 5_000 })
          if (r.exitCode !== 0) return { text: `Could not remove ${found.path}: ${r.stderr.trim()}` }
          return { text: `Removed ${describe(found.data)} (its file is gone; its login elsewhere is untouched).` }
        }
        case 'allow':
        case 'ask':
        case 'block': {
          const accounts = await listAccounts($)
          await ensureLabels($, accounts)
          const found = findAccount(accounts, tail)
          if ('error' in found) return { text: found.error }
          const r = await setLevel($, found, verb.toLowerCase() as Level)
          if (r.refused) return { text: r.text }
          const text = r.text
          return { text, context: [`The user changed this with /account ${verb}: ${text}`] }
        }
        case 'settings':
        case 'ui':
          await openPane($)
          return { text: 'Account settings opened: Tab or arrows move between accounts, Enter changes what the model may do, Esc closes.' }
        case 'where':
        case 'doctor':
          return { text: await whereReport($) }
        case 'auto': {
          const v = tail.toLowerCase()
          if (!['on', 'off', 'default'].includes(v)) return { text: `The model may switch on its own: ${(await modelMaySwitch($)) ? 'yes' : 'no'}. ${usage}` }
          await setModelMaySwitch($, v === 'default' ? null : v === 'on')
          const may = await modelMaySwitch($)
          const text = `The model may switch accounts on its own: ${may ? 'yes' : 'no'}.`
          return { text, context: [`The user changed this with /account auto: ${may ? 'you may now switch accounts on your own when it helps' : 'you may NOT switch accounts on your own any more – suggest switches to the user instead'}.`] }
        }
        default:
          return { text: usage }
      }
    } catch (err) {
      return { text: `Account switcher: ${errorText(err)}` }
    }
  })
}
