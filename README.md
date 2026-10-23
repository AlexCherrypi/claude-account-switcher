# Account switcher for Claude Code

A Claude Code mod for people with more than one Claude account. It keeps every account you sign
in with in a file of its own, switches Claude Code to another account in seconds (no restart, no
`/login`), and reads the 5-hour and 7-day limits of **every** account without switching to it.
If you let it (on by default), the model can do the same on its own, e.g. to move to an account
with room when the active one runs out. It works together with [CTM](https://github.com/AlexCherrypi/ctm).

## What it keeps

One JSON file per account, in `<Claude config dir>/account-switcher/accounts/<accountUuid>_<organizationUuid>.json`
(`~/.claude/account-switcher/accounts/` by default, readable by you alone). An account is the
person **and** the organization it signed in for: one email in a personal plan and in a team is
two accounts, each with its own login and limits.

| Field | What |
|---|---|
| `label` | Its short name, unique among your accounts. It is given automatically: the first name (or what stands before the @), lower case, with `-2`, `-3` behind it where taken (`alex`, `alex-2`). Change it with `/account label <name> <new>` |
| `email`, `displayName`, `organizationName`, `organizationUuid`, `subscriptionType` | Who it is, to tell the accounts apart |
| `oauthAccount` | The account record Claude Code keeps in `~/.claude.json` |
| `claudeAiOauth` | The login itself: access token, refresh token, expiry, scopes |
| `lastUsage` | The last 5-hour / 7-day reading |
| `needsLogin` | Set when its refresh token was refused: sign in with it again |
| `note`, `noteBy`, `noteAt` | Its note (see [Notes per account](#notes-per-account)), who wrote it (`user` or `model`) and when |

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
  - to an account on your **allow list** at once, at most once every `switchCooldownMinutes`
    (default 5), so it doesn't switch back and forth,
  - to any other account only after **you confirm it** in a dialog the plugin opens (see below),
  - from the main agent, never a subagent,
  - with a `reason`, which shows in the result and as a toast.
- `mcp__account-switcher__save` `{ label? }`: saves the account Claude Code is signed in with now.
- `mcp__account-switcher__note` `{ account, text? }`: reads an account's note, or with `text`
  replaces it (`""` removes it). You get a toast whenever the model changes a note.

The model also gets a short briefing in its system prompt: when a limit runs high, check the
other accounts first. If one has room and the model may switch, it switches at a clean point and
carries on instead of pausing. If it may not, it tells you which account has room.

## Allow list

Each account says whether the model may switch to it on its own:

- **On the list** (`/account allow <name>`): the model switches to it at once when it needs to.
- **Off the list** (`/account ask <name>`, the default for every new login): the model's `switch`
  opens a dialog, *"Switch the Claude account to … ? Reason given: …"*, with **Switch** and
  **Don't switch**. The plugin asks this, not the model, so the model can't answer it, and no
  permission mode or auto-mode classifier settles it. If you dismiss the dialog, or nobody can be
  asked (`claude -p`), nothing is switched.

- **Excluded** (`/account block <name>`): the model may not switch to it at all, not even by
  asking. Its `switch` is refused with *"the user has excluded … from switches by you"*, no dialog
  opens, and the account is never offered to it as the one with the most room. You can still
  switch there yourself with `/account switch`. `/account ask` or `/account allow` lifts the
  block.

- **Asking enforced** (option `alwaysAsk`): a comma-separated list of emails, domains
  (`@wemotion.io`) or organization names. For a matching account the model always has to ask,
  whatever the account's own setting says, and `/account allow` is refused for it. Because it is
  a plugin option, an organization can pin it in managed settings
  (`pluginConfigs` → `account-switcher` → `options` → `alwaysAsk`), where neither the user nor the
  model can change it.

**The settings pane.** `/account` (or `/account settings`) opens a pane to manage your accounts. Each account
shows its short name, email, organization and plan, its last limits, and what the model may do.
Below that are its buttons:

- **[model: …]**: Enter steps it on, *switch freely → ask first → never*. It skips *switch
  freely* where asking is enforced.
- **Switch here**: your own switch, so it never asks. The model is told with its next turn.
- **Remove**: deletes the account's file. The first press asks *Really remove? Press again*.
  The active account has no Remove, because autoSave would save it again at once.
- **Name**: a text field to rename it. A name another account carries is refused. Mobile draws
  no text fields, so use `/account label` there.
- **Note**: a text field for its note (empty removes it). The model is told with its next turn.
  On mobile, use `/account note`.

At the top, **Read limits anew** asks the server for every account's limits. **Tab** or the
arrows move between the buttons, **Enter** presses one, and **Esc** closes the pane.

`/account` shows each account as *model may switch here*, *model asks first*, *model asks first
(enforced)* or *model may NOT switch here*.

**The model can't get around it through the files.** The account files hold every saved login,
plus the per-account settings. The plugin refuses the model's file tools (Read, Write, Edit, Grep,
…) aimed into the account store, judged by where the path really leads. It also refuses shell
commands that name the store. That check is best effort, because a command can name a path in
many ways. Your own
`/account switch` never asks. `/account auto off` stops the model switching at all, list or not.

## Notes per account

Each account can carry a note: what you want kept in mind for it, e.g. *weekends only* or
*7-day at most 60%*. Set it with `/account note <name> <text>` (no text removes it), in the
pane, or let the model set it with its `note` tool.

A note is a hint, nothing more: the plugin enforces nothing. It is shown wherever the account
is named – `/account list`, the pane, the model's account list (*Note (by the user): …*), a
switch's answer, and the message about a switch made elsewhere. The model is told that notes are
your instructions for that account and that it follows them when it picks an account or
switches. A note the model wrote is marked *by a model*; your word wins over it.

## Switches made elsewhere

Every switch writes `~/.claude.json` – this plugin in another Claude Code session, a `/login`,
or a change by hand. The plugin looks at that file's modification time every 10 s (nothing more
is read while it is unchanged). When it names another account than before, and the change was
not this session's own switch, the model is told in a message: from which account to which,
the new account's 5-hour and 7-day limits (read at once), what the model may do there, and its
note. You get a toast. A stale record another session writes back over the new login is set
right and not reported.

## With CTM

- CTM's blocks show the **active** account's limits. CTM notices a switch through
  `oauthAccount.accountUuid` in `~/.claude.json`, and its next block shows the new account's
  figures, with no Δ against the old account.
- When a block asks the model to pause (your pause threshold or CTM's built-in safety net), CTM
  first points it to `mcp__account-switcher__accounts` / `…__switch`. It does so only where this
  plugin is installed, and only for the main agent.

## Names

You name an account in `/account switch` and the model names it in its `switch` tool. Both
accept any of these:

1. its **label** (`alex-2`): unique, and it always wins
2. its email, display name or organization name, if exactly one account has it
3. a unique part of any of these (`wemotion`, `club`)
4. its number in `/account`'s list, or its uuid

If a name fits several accounts, nothing is switched and the answer lists them with their
organizations. A label another account already carries is refused.

## `/account`

```
/account                      open the settings pane (where nothing can draw it, the list)
/account list                 list the accounts with their limits (a reading up to 3 min old)
/account usage                the same, every account read anew
/account save [label]         save the account signed in now (optionally with a label)
/account switch <name>        switch (label, email, name, number or uuid; a unique part is enough)
/account label <name> <label> set or (no label) remove a label
/account note <name> [text]   set or (no text) remove an account's note
/account remove <name>        delete an account's file (not the active one)
/account settings             a pane to manage them: level, switch, rename, remove, read limits
/account allow <name>         let the model switch to this account on its own
/account ask <name>           the model asks you before it switches to this account (the default)
/account block <name>         the model may never switch to this account (you still can)
/account auto on|off|default  let the model switch at all, or not
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

## Languages

What you read comes in **English, German or French**: `/account` and its subcommands, the
settings pane, the toasts, and the dialog that asks before a switch. The language is the
`language` option if set, else Claude Code's own `language` setting, else the system's (`LANG`,
`LC_ALL`), and English otherwise. Any text missing in a language falls back to English.

What the model reads stays English: the tool descriptions, its tool results and its briefing.
It reads that most reliably, and the words it matches on ("model may switch here") stay the same
whatever you read.

## Options (`/plugin` → account-switcher → configure, or `/config`)

| Option | Default | Meaning |
|---|---|---|
| `allowModelSwitch` | true | The model may switch on its own (`/account auto` overrides it, kept across sessions) |
| `switchCooldownMinutes` | 5 | Minimum time between two switches by the model, 0 = none |
| `alwaysAsk` | empty | Emails, `@domains` or organization names the model must always ask for (see [Allow list](#allow-list)) |
| `language` | auto | `auto`, `en`, `de` or `fr`: the language of what you read (see [Languages](#languages)) |
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
