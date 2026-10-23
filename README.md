# Account switcher for Claude Code

A Claude Code mod for people with more than one Claude account. It keeps every account you sign
in with in a file of its own, switches Claude Code to another account in seconds (no restart, no
`/login`), and reads the 5-hour and 7-day limits of **every** account without switching to it.
If you let it (on by default), the model can do the same on its own, e.g. to move to an account
with room when the active one runs out. It works together with [CTM](https://github.com/AlexCherrypi/ctm).

## What it keeps

One JSON file per account, in `<Claude config dir>/account-switcher/accounts/<accountUuid>.json`
(`~/.claude/account-switcher/accounts/` by default, readable by you alone):

| Field | What |
|---|---|
| `label` | Your own name for it (`work`, `private`, …), set with `/account save <label>` or `/account label` |
| `email`, `displayName`, `organizationName`, `organizationUuid`, `subscriptionType` | Who it is, to tell the accounts apart |
| `oauthAccount` | The account record Claude Code keeps in `~/.claude.json` |
| `claudeAiOauth` | The login itself: access token, refresh token, expiry, scopes |
| `lastUsage` | The last 5-hour / 7-day reading |
| `needsLogin` | Set when its refresh token was refused: sign in with it again |

**These files hold your login tokens.** Treat them like passwords: don't sync, share or commit
them.

## How a switch works

1. The tokens Claude Code holds **now** are written back to the active account's file. Claude
   Code renews them now and then, and the old pair stops working, so this has to happen on
   every switch.
2. The target account's login is checked: its limits are read, and an expired token is renewed
   with its refresh token (the new pair is saved at once). A target whose login no longer works
   is refused, and nothing changes.
3. Its tokens go where Claude Code keeps its login: `~/.claude/.credentials.json` (Linux,
   Windows) or the macOS keychain (`Claude Code-credentials`). Anything else stored there,
   such as MCP servers' tokens, stays as it is.
4. Its `oauthAccount` replaces the one in `~/.claude.json`. Every other key stays as it is.
5. Claude Code sees that its login changed and uses the new one from its next request on.

The switch applies to the **whole machine**: every Claude Code session that uses the same config
dir runs on the new account from then on.

## Platforms

Claude Code keeps a login in two places. The plugin reads and writes both on every system:

| | Tokens (`claudeAiOauth`) | Account record (`oauthAccount`) |
|---|---|---|
| **macOS** | Keychain item `Claude Code-credentials` (with `-<hash>` behind it when `CLAUDE_CONFIG_DIR` is set), account `$USER`; read and written with `/usr/bin/security`, as Claude Code does, the secret over stdin. If the keychain has no item, `~/.claude/.credentials.json`. | `~/.claude.json` |
| **Linux** | `~/.claude/.credentials.json` | `~/.claude.json` |
| **Windows** | `%USERPROFILE%\.claude\.credentials.json` (`USERPROFILE`, not a `HOME` that Git Bash set) | `%USERPROFILE%\.claude.json` |
| **iOS** | Claude Code does not run there. The app drives a cloud session (its login belongs to the host and can't be switched) or, through Remote Control, a session on your computer. There the plugin runs as on that computer. | |

With `CLAUDE_CONFIG_DIR` set, both live in that folder instead.

- **Tokens and record must agree.** CTM, and Claude Code's own displays, read the account from
  `~/.claude.json`. A Claude Code session that still holds the old record can write it back after
  a switch. So before the plugin saves tokens to an account's file, it checks whose they are: a
  saved account's own pair is that account's, and new tokens (Claude Code renewed them, or you
  logged in again) are asked of the server (`/api/oauth/profile`). If the record names another
  account, it is set back to the right one, never the other way round. The plugin looks again 10 s,
  30 s, 1 min and 2 min after a switch, and every 5 minutes.
- **A locked keychain** (e.g. over SSH) is reported as an error. The plugin then does not fall back
  to a `.credentials.json` that may be old.
- **`/account where`** shows what the plugin found on your machine: the system, the paths, the
  keychain item, where the login is, and whether tokens and record agree.

### Checking a new system by hand

1. `/account where`: the login is found, and tokens and record agree.
2. `/account save first`, then `/login` with a second account, then `/account`: both are listed.
3. `/account usage`: both show their limits.
4. `/account switch first`, then `/status` (or CTM's next block): the first account is active, and
   a prompt works without a new login.
5. Switch back and forth a few times, with a second Claude Code session open: both keep working.

## Limits without switching

For the active account the limits are read with the session's own credential. For every other
account they are read with that account's token from its file (`GET /api/oauth/usage`, the
endpoint `/usage` uses: no model request, no tokens spent). If a token has expired, it is renewed
first and the new pair is saved. The active account's tokens are **never** renewed here: they
belong to Claude Code, and renewing them here would void the pair it holds. A reading is reused
for 3 minutes, and `refresh` reads again (at most every 30 s per account).

## Tools for the model

- `mcp__account-switcher__accounts` `{ refresh? }`: the saved accounts, which one is active, each
  one's 5-hour and 7-day limits, the account with the most room, and whether the model may
  switch.
- `mcp__account-switcher__switch` `{ account, reason }`: switches to another saved account, which
  the model names by label, email, display name, its number in the list, or uuid. The model can
  only switch:
  - while you allow it (option `allowModelSwitch`, or `/account auto on|off`; on by default),
  - at most once every `switchCooldownMinutes` (default 5), so it doesn't switch back and forth,
  - from the main agent, never a subagent,
  - with a `reason`, which shows in the result and as a toast.
- `mcp__account-switcher__save` `{ label? }`: saves the account Claude Code is signed in with now.

The model also gets a short briefing in its system prompt: when a limit runs high, check the
other accounts first. If one has room and the model may switch, it switches at a clean point and
carries on instead of pausing. If it may not, it tells you which account has room.

## With CTM

- CTM's blocks show the **active** account's limits. CTM notices a switch through
  `oauthAccount.accountUuid` in `~/.claude.json`, and its next block shows the new account's
  figures, with no Δ against the old account.
- When a block asks the model to pause (your pause threshold or CTM's built-in safety net), CTM
  first points it to `mcp__account-switcher__accounts` / `…__switch`. It does so only where this
  plugin is installed, and only for the main agent.

## `/account`

```
/account                      list the accounts with their limits (a reading up to 3 min old)
/account usage                the same, every account read anew
/account save [label]         save the account signed in now (optionally with a label)
/account switch <name>        switch (label, email, name, number or uuid; a unique part is enough)
/account label <name> <label> set or (no label) remove a label
/account remove <name>        delete an account's file (not the active one)
/account auto on|off|default  let the model switch on its own, or not
/account where                where this machine keeps the login, and whether it is consistent
```

Your own `/account switch` is never held back by the cooldown or by `auto off`.

## Adding accounts

Just `/login` with each account. The store grows on its own (`autoSave`, on by default):

- Right before `/login` (and `/logout`) the account signed in so far is saved with the tokens it
  holds **now**. `/login` overwrites them, and Claude Code may have renewed them since the last
  save.
- Once the login is through, the new account is saved. The plugin looks 5 s, 15 s, 30 s, 1 min and
  2 min after the command, because the login dialog can outlast it, and every 5 minutes after
  that.
- An account you already have is updated, not saved twice. Its label stays.

`/account save <label>` is only needed to give an account a name (`/account label` does that
later too). From then on you switch with `/account switch`, without logging in again.

If an account shows **NEEDS A NEW LOGIN**, its refresh token was refused (revoked, or used
up elsewhere). Sign in with it again (`/login`), and its file is updated.

## Options (`/plugin` → account-switcher → configure, or `/config`)

| Option | Default | Meaning |
|---|---|---|
| `allowModelSwitch` | true | The model may switch on its own (`/account auto` overrides it, kept across sessions) |
| `switchCooldownMinutes` | 5 | Minimum time between two switches by the model, 0 = none |
| `autoSave` | true | Save every new account you sign in with on its own. A saved account's file is always kept current as Claude Code renews its tokens (checked every 5 minutes, and at every switch and session end) |
| `storeDir` | empty | Folder for the account files; empty = `<config dir>/account-switcher/accounts` |
| `keychainService` | empty | macOS only: the keychain item Claude Code uses, if it isn't the detected one (`Claude Code-credentials`, plus `-<hash>` when `CLAUDE_CONFIG_DIR` is set) |

## Install

```
/plugin install account-switcher --marketplace AlexCherrypi/claude-account-switcher
```

From a shell:

```
claude plugin install account-switcher --marketplace AlexCherrypi/claude-account-switcher
```

To try it locally: `claude --plugin-dir /path/to/claude-account-switcher`.

Needs a Claude Code version with function-hook mods (the same one CTM needs, v2.1.287 or later)
and a claude.ai login (Pro, Max, Team or Enterprise). API keys and cloud providers have no
accounts to switch.

## Notes

- Switching while another Claude Code session on the same machine is mid-request is safe for
  that request. That session's next request then runs on the new account.
- If Claude Code renews the active account's tokens in the moment between the plugin saving them
  and switching away, that renewal is lost, and the account may then need a new `/login`. The
  periodic sync makes the window small.
- Develop / check: `claude plugin validate .` and `claude plugin test .`.
