// What the person reads, in English, German and French. English is the fallback for a
// language or a text not here. What the model reads (tool descriptions, its tool results,
// its briefing) stays English: it reads that most reliably.

export type Lang = 'en' | 'de' | 'fr'

type Who = string

const en = {
  // Spans and limits
  min: (n: number) => `${n} min`,
  hmin: (h: number, m: number) => `${h} h ${m} min`,
  dh: (d: number, h: number) => `${d} d ${h} h`,
  fiveHour: '5-hour',
  sevenDay: '7-day',
  windowReset: (name: string) => `${name} 0% (window reset since the reading)`,
  limit: (name: string, percent: string, resetsIn: string | null) => `${name} ${percent}${resetsIn ? ` (resets in ${resetsIn})` : ''}`,
  noLimits: 'no 5-hour / 7-day limits reported',
  limitsUnknown: 'limits unknown',
  limitsNotRead: 'limits not read yet',
  readJustNow: 'read just now',
  readAgo: (span: string) => `read ${span} ago`,
  full: 'FULL',

  // Naming an account
  nameIt: 'name the account: its label, email, name, number in the list, or uuid',
  fits: (query: string, n: number, list: string) => `"${query}" fits ${n} accounts: ${list} – be more precise`,
  noneFits: (query: string, saved: string | null) =>
    `no saved account fits "${query}"${saved ? ` (saved: ${saved})` : ' – none is saved yet'}`,
  labelTaken: (label: string, other: Who) => `the label "${label}" is taken by ${other} – pick another, or relabel that one first`,

  // Levels
  levelAllow: 'switch freely',
  levelAsk: 'ask first',
  levelBlock: 'never',
  listMayNot: 'model may NOT switch here',
  listAsksEnforced: 'model asks first (enforced)',
  listMay: 'model may switch here',
  listAsks: 'model asks first',
  alwaysAskRefused: (who: Who) =>
    `${who} is on the always-ask list (option alwaysAsk): the model must ask you before it switches there, and that ` +
    'cannot be lifted here. Change the option (or, if your organization set it, ask them).',
  nowAllow: (who: Who) => `The model may now switch to ${who} on its own.`,
  nowAsk: (who: Who) => `The model now asks you before it switches to ${who}.`,
  nowBlock: (who: Who) => `The model may no longer switch to ${who} at all, not even by asking. You still can (/account switch).`,

  // Managing
  removeActive: (who: Who) => `${who} is the active account and would be saved again at once (autoSave). Switch away first.`,
  removeFailed: (path: string, why: string) => `Could not remove ${path}: ${why}`,
  removed: (who: Who) => `Removed ${who} (its file is gone; its login elsewhere is untouched).`,
  renamed: (who: Who) => `Renamed: ${who}.`,
  labelled: (who: Who) => `Labelled ${who}.`,
  labelRemoved: (who: Who) => `Label removed: ${who}.`,
  saved: (who: Who, path: string) => `Saved ${who} (${path}).`,
  updated: (who: Who, path: string) => `Updated ${who} (${path}).`,
  nothingToSave: 'Not signed in with a claude.ai account – nothing to save.',

  // The list
  header: (n: number, active: string) => `Accounts: ${n} saved · active: ${active}`,
  activeUnsaved: (email: string) => `${email} (not saved – /account save)`,
  notSignedIn: 'none (not signed in with a claude.ai account)',
  needsLogin: 'NEEDS A NEW LOGIN (its refresh token was refused)',
  couldNotReadAnew: (why: string) => `could not read anew: ${why}`,
  couldNotReadLogin: (why: string) => `(Could not read the current login: ${why})`,
  mostRoom: (n: number, name: string, limits: string) => `Most room elsewhere: ${n}. ${name} – ${limits}`,
  noRoom: 'No other account with room known.',
  onlyOne: 'Only one account saved: switching needs another (sign in with it via /login – it is saved on its own – then come back).',
  userModelMay: (cooldown: number) =>
    `The model may switch on its own to accounts marked "model may switch here"${cooldown > 0 ? ` (at most every ${cooldown} min)` : ''}, ` +
    'asks you first for the others, and never switches to one marked "model may NOT switch here".',
  userModelMayNot: 'The model may not switch accounts on its own (/account auto on allows it).',

  // Switching
  already: (who: Who) => `Already on ${who} – nothing to switch.`,
  notSavedNoAuto: (email: string, save: string) =>
    `the account signed in now (${email}) is not saved, and autoSave is off – its login would be lost. Save it first (/account save, or ${save}).`,
  cannotSignIn: (who: Who, why: string) => `${who} cannot be signed in: ${why}`,
  tokenRanOut: (who: Who, why: string) => `${who}: its token ran out and could not be renewed (${why}) – try again later`,
  writeFailed: (why: string, restored: boolean) =>
    `could not write the login (${why}) – ` +
    (restored ? 'the old login is back in place, nothing changed' : 'and the old login could not be put back: sign in again with /login'),
  configFailed: (path: string, why: string) => `could not update ${path} (${why}) – the old login is back in place`,
  didNotHold: 'the switch did not hold – something else wrote the login at the same time; check with /account',
  noSavedAccount: 'no saved account',
  switched: (from: Who, to: Who, reason: string | null) => `Switched from ${from} to ${to}.${reason ? ` Reason: ${reason}` : ''}`,
  itsLimits: (limits: string, why: string | null) => `Its limits: ${limits}${why ? ` (could not read anew: ${why})` : ''}.`,
  sessionsFollow:
    'Claude Code uses the new login from its next request on. Every Claude Code session on this machine that shares this config dir now runs on it too.',
  toastSwitched: (name: string, byModel: boolean) => `Account: switched to ${name}${byModel ? ' (by the model)' : ''}`,
  toastRecordFixed: (name: string) => `Account: ~/.claude.json named another account than the login – set back to ${name}`,

  // The dialog the model's switch opens
  askHeader: 'Account',
  askQuestion: (who: Who, reason: string) => `Switch the Claude account to ${who}? Reason given: ${reason}`,
  askSwitch: 'Switch',
  askSwitchHint: 'Switch now; every Claude Code session on this machine follows.',
  askStay: 'Don’t switch',
  askStayHint: 'Stay on the current account.',

  // Notes
  noteLine: (note: string, byModel: boolean) => `Note${byModel ? ' (by the model)' : ''}: ${note}`,
  noteSet: (who: Who) => `Note saved for ${who}.`,
  noteRemoved: (who: Who) => `Note removed for ${who}.`,
  toastNoteByModel: (name: string, note: string | null) => `Account: the model ${note ? `set the note on ${name}: ${note}` : `removed the note on ${name}`}`,
  toastElsewhere: (name: string) => `Account: now on ${name} – switched elsewhere (another session or /login)`,
  paneNote: 'Note',
  paneSaveNote: 'Save note',

  // The settings pane
  paneTitle: 'Accounts',
  paneHelp: 'Tab / arrows: move · Enter: press · Esc: close',
  paneReadAnew: 'Read limits anew',
  paneNone: 'No account saved yet – sign in with /login, it is saved on its own.',
  paneModel: (level: string, enforced: boolean) => `[model: ${level}${enforced ? ', enforced' : ''}]`,
  paneActive: 'active',
  paneSwitchHere: 'Switch here',
  paneRemove: 'Remove',
  paneReallyRemove: 'Really remove? Press again',
  paneName: 'Name',
  paneRename: 'Rename',
  paneLegend: 'model: switch freely = at once · ask first = a dialog asks you · never = only you can switch there',
  paneReading: 'Account: reading every account’s limits …',
  paneRead: 'Account: limits read',
  paneGone: 'already gone',
  paneSwitched: (name: string) => `switched to ${name}`,
  settingsOpened: 'Account settings opened: Tab or arrows move between accounts, Enter changes what the model may do, Esc closes.',

  // /account
  usage:
    'Usage: /account (the pane) · /account [list|usage|where] · /account allow|ask|block <name> · /account note <name> [text] · /account save [label] · /account switch <name> · /account label <name> <label> · /account remove <name> · /account auto on|off|default',
  autoState: (may: boolean) => `The model may switch on its own: ${may ? 'yes' : 'no'}.`,
  autoChanged: (may: boolean) => `The model may switch accounts on its own: ${may ? 'yes' : 'no'}.`,
  failed: (why: string) => `Account switcher: ${why}`,

  // /account where
  whereSystem: (s: string) => `System: ${s}`,
  whereOther: 'Linux / other Unix',
  whereHome: (h: string | null) => `Home: ${h ?? '(none – neither HOME nor USERPROFILE is set)'}`,
  whereConfig: (d: string) => `Claude config dir: ${d}`,
  whereKeychain: (service: string, user: string) => `Keychain item looked for: "${service}" (account "${user}")`,
  whereCredentials: (path: string, mac: boolean) => `Credentials file${mac ? ' (used where the keychain has no item)' : ''}: ${path}`,
  whereRecord: (path: string) => `Account record: ${path} (oauthAccount – CTM reads it too)`,
  whereStore: (path: string) => `Account store: ${path}`,
  whereLoginIn: (where: string) => `Login found in: ${where}`,
  whereKeychainAt: (service: string) => `the macOS keychain ("${service}")`,
  whereBroken: ' – but it is BROKEN (no readable JSON, cut short by a failed write): /account switch <a saved account> or /login repairs it',
  whereNoTokens: ' – but it holds no claude.ai tokens (an API key, a cloud provider, or not signed in)',
  whereRecordNames: (email: string, account: string, org: string) => `Account record names: ${email} (account ${account}, organization ${org})`,
  whereRecordNone: 'Account record names: no account',
  whereSavedYes: (who: Who, at: string, path: string) => `Saved in the store: yes – ${who}, last written ${at} (${path})`,
  whereSavedNot: (auto: boolean) =>
    `Saved in the store: not yet – ${auto ? 'it is saved with the next /account or within 5 min (autoSave)' : 'autoSave is off: /account save'}`,
  whereInStore: (n: number, names: string) => `Accounts in the store: ${n}${n ? ` (${names})` : ''}`,
  whereAgree: 'Tokens and record agree.',
  whereOwner: (who: string) => `Tokens belong to ${who} – the record names another (the next sync sets it right where that one is saved).`,
  whereOtherOwner: (key: string) => `another account or organization (${key})`,
  whereCannotRead: (why: string) => `Could not read the login: ${why}`,
}

type Messages = typeof en

const de: Partial<Messages> = {
  min: n => `${n} Min.`,
  hmin: (h, m) => `${h} Std. ${m} Min.`,
  dh: (d, h) => `${d} T. ${h} Std.`,
  fiveHour: '5-Stunden',
  sevenDay: '7-Tage',
  windowReset: name => `${name} 0 % (Fenster seit dem Lesen zurückgesetzt)`,
  limit: (name, percent, resetsIn) => `${name} ${percent}${resetsIn ? ` (Reset in ${resetsIn})` : ''}`,
  noLimits: 'keine 5-Stunden- / 7-Tage-Limits gemeldet',
  limitsUnknown: 'Limits unbekannt',
  limitsNotRead: 'Limits noch nicht gelesen',
  readJustNow: 'gerade gelesen',
  readAgo: span => `vor ${span} gelesen`,
  full: 'VOLL',

  nameIt: 'Nenne den Account: Kurzname, E-Mail, Name, Nummer in der Liste oder UUID',
  fits: (query, n, list) => `„${query}“ passt zu ${n} Accounts: ${list} – bitte genauer`,
  noneFits: (query, saved) => `Kein gespeicherter Account passt zu „${query}“${saved ? ` (gespeichert: ${saved})` : ' – noch keiner gespeichert'}`,
  labelTaken: (label, other) => `Der Name „${label}“ ist schon vergeben an ${other} – nimm einen anderen oder benenne den erst um`,

  levelAllow: 'frei wechseln',
  levelAsk: 'erst fragen',
  levelBlock: 'nie',
  listMayNot: 'KI darf NICHT hierher wechseln',
  listAsksEnforced: 'KI fragt erst (erzwungen)',
  listMay: 'KI darf hierher wechseln',
  listAsks: 'KI fragt erst',
  alwaysAskRefused: who =>
    `${who} steht auf der Immer-fragen-Liste (Option alwaysAsk): Die KI muss dich fragen, bevor sie dorthin wechselt, ` +
    'und das lässt sich hier nicht aufheben. Ändere die Option (oder frag deine Organisation, falls sie sie gesetzt hat).',
  nowAllow: who => `Die KI darf jetzt von selbst zu ${who} wechseln.`,
  nowAsk: who => `Die KI fragt dich jetzt, bevor sie zu ${who} wechselt.`,
  nowBlock: who => `Die KI darf gar nicht mehr zu ${who} wechseln, auch nicht auf Nachfrage. Du selbst kannst es weiterhin (/account switch).`,

  removeActive: who => `${who} ist der aktive Account und würde sofort wieder gespeichert (autoSave). Wechsle erst weg.`,
  removeFailed: (path, why) => `Konnte ${path} nicht entfernen: ${why}`,
  removed: who => `${who} entfernt (die Datei ist gelöscht; der Login anderswo bleibt unberührt).`,
  renamed: who => `Umbenannt: ${who}.`,
  labelled: who => `Benannt: ${who}.`,
  labelRemoved: who => `Name entfernt: ${who}.`,
  saved: (who, path) => `${who} gespeichert (${path}).`,
  updated: (who, path) => `${who} aktualisiert (${path}).`,
  nothingToSave: 'Nicht mit einem claude.ai-Account angemeldet – nichts zu speichern.',

  header: (n, active) => `Accounts: ${n} gespeichert · aktiv: ${active}`,
  activeUnsaved: email => `${email} (nicht gespeichert – /account save)`,
  notSignedIn: 'keiner (nicht mit einem claude.ai-Account angemeldet)',
  needsLogin: 'BRAUCHT EIN NEUES LOGIN (sein Refresh-Token wurde abgelehnt)',
  couldNotReadAnew: why => `konnte nicht neu gelesen werden: ${why}`,
  couldNotReadLogin: why => `(Konnte den aktuellen Login nicht lesen: ${why})`,
  mostRoom: (n, name, limits) => `Am meisten Platz woanders: ${n}. ${name} – ${limits}`,
  noRoom: 'Kein anderer Account mit Platz bekannt.',
  onlyOne: 'Nur ein Account gespeichert: Zum Wechseln braucht es einen zweiten (mit /login anmelden – er wird von selbst gespeichert).',
  userModelMay: cooldown =>
    `Die KI wechselt von selbst zu Accounts mit „KI darf hierher wechseln“${cooldown > 0 ? ` (höchstens alle ${cooldown} Min.)` : ''}, ` +
    'fragt dich bei den anderen vorher und wechselt nie zu einem mit „KI darf NICHT hierher wechseln“.',
  userModelMayNot: 'Die KI darf nicht von selbst wechseln (/account auto on erlaubt es).',

  already: who => `Schon auf ${who} – nichts zu wechseln.`,
  notSavedNoAuto: (email, save) =>
    `Der angemeldete Account (${email}) ist nicht gespeichert und autoSave ist aus – sein Login ginge verloren. Speichere ihn zuerst (/account save oder ${save}).`,
  cannotSignIn: (who, why) => `${who} lässt sich nicht anmelden: ${why}`,
  tokenRanOut: (who, why) => `${who}: Sein Token ist abgelaufen und ließ sich nicht erneuern (${why}) – versuch es später noch einmal`,
  writeFailed: (why, restored) =>
    `Konnte den Login nicht schreiben (${why}) – ` +
    (restored ? 'der alte Login ist wieder da, nichts geändert' : 'und der alte Login ließ sich nicht zurückschreiben: Melde dich mit /login neu an'),
  configFailed: (path, why) => `Konnte ${path} nicht aktualisieren (${why}) – der alte Login ist wieder da`,
  didNotHold: 'Der Wechsel hat nicht gehalten – etwas anderes hat den Login gleichzeitig geschrieben; prüf es mit /account',
  noSavedAccount: 'keinem gespeicherten Account',
  switched: (from, to, reason) => `Gewechselt von ${from} zu ${to}.${reason ? ` Grund: ${reason}` : ''}`,
  itsLimits: (limits, why) => `Seine Limits: ${limits}${why ? ` (konnte nicht neu gelesen werden: ${why})` : ''}.`,
  sessionsFollow:
    'Claude Code nutzt den neuen Login ab seiner nächsten Anfrage. Alle Claude-Code-Sitzungen auf diesem Rechner mit demselben Config-Ordner laufen jetzt ebenfalls darauf.',
  toastSwitched: (name, byModel) => `Account: gewechselt zu ${name}${byModel ? ' (durch die KI)' : ''}`,
  toastRecordFixed: name => `Account: ~/.claude.json nannte einen anderen Account als der Login – auf ${name} zurückgesetzt`,

  askHeader: 'Account',
  askQuestion: (who, reason) => `Den Claude-Account zu ${who} wechseln? Angegebener Grund: ${reason}`,
  askSwitch: 'Wechseln',
  askSwitchHint: 'Jetzt wechseln; alle Claude-Code-Sitzungen auf diesem Rechner folgen.',
  askStay: 'Nicht wechseln',
  askStayHint: 'Beim aktuellen Account bleiben.',

  noteLine: (note, byModel) => `Notiz${byModel ? ' (von der KI)' : ''}: ${note}`,
  noteSet: who => `Notiz für ${who} gespeichert.`,
  noteRemoved: who => `Notiz für ${who} entfernt.`,
  toastNoteByModel: (name, note) => `Account: die KI hat ${note ? `die Notiz zu ${name} gesetzt: ${note}` : `die Notiz zu ${name} entfernt`}`,
  toastElsewhere: name => `Account: jetzt auf ${name} – woanders gewechselt (andere Sitzung oder /login)`,
  paneNote: 'Notiz',
  paneSaveNote: 'Notiz speichern',

  paneTitle: 'Accounts',
  paneHelp: 'Tab / Pfeile: bewegen · Enter: drücken · Esc: schließen',
  paneReadAnew: 'Limits neu lesen',
  paneNone: 'Noch kein Account gespeichert – melde dich mit /login an, er wird von selbst gespeichert.',
  paneModel: (level, enforced) => `[KI: ${level}${enforced ? ', erzwungen' : ''}]`,
  paneActive: 'aktiv',
  paneSwitchHere: 'Hierher wechseln',
  paneRemove: 'Entfernen',
  paneReallyRemove: 'Wirklich entfernen? Noch einmal drücken',
  paneName: 'Name',
  paneRename: 'Umbenennen',
  paneLegend: 'KI: frei wechseln = sofort · erst fragen = ein Dialog fragt dich · nie = nur du kannst dorthin wechseln',
  paneReading: 'Account: lese die Limits aller Accounts …',
  paneRead: 'Account: Limits gelesen',
  paneGone: 'schon weg',
  paneSwitched: name => `gewechselt zu ${name}`,
  settingsOpened: 'Account-Einstellungen geöffnet: Tab oder Pfeile wechseln den Account, Enter ändert, was die KI darf, Esc schließt.',

  usage:
    'Verwendung: /account (das Fenster) · /account [list|usage|where] · /account allow|ask|block <Name> · /account note <Name> [Text] · /account save [Name] · /account switch <Name> · /account label <Name> <neuer Name> · /account remove <Name> · /account auto on|off|default',
  autoState: may => `Die KI darf von selbst wechseln: ${may ? 'ja' : 'nein'}.`,
  autoChanged: may => `Die KI darf Accounts von selbst wechseln: ${may ? 'ja' : 'nein'}.`,
  failed: why => `Account-Switcher: ${why}`,

  whereSystem: s => `System: ${s}`,
  whereOther: 'Linux / anderes Unix',
  whereHome: h => `Home: ${h ?? '(keins – weder HOME noch USERPROFILE gesetzt)'}`,
  whereConfig: d => `Claude-Config-Ordner: ${d}`,
  whereKeychain: (service, user) => `Gesuchter Schlüsselbund-Eintrag: „${service}“ (Konto „${user}“)`,
  whereCredentials: (path, mac) => `Credentials-Datei${mac ? ' (genutzt, wenn der Schlüsselbund keinen Eintrag hat)' : ''}: ${path}`,
  whereRecord: path => `Account-Eintrag: ${path} (oauthAccount – liest auch CTM)`,
  whereStore: path => `Account-Speicher: ${path}`,
  whereLoginIn: where => `Login gefunden in: ${where}`,
  whereKeychainAt: service => `dem macOS-Schlüsselbund („${service}“)`,
  whereBroken: ' – aber er ist KAPUTT (kein lesbares JSON, von einem fehlgeschlagenen Schreiben abgeschnitten): /account switch <gespeicherter Account> oder /login repariert ihn',
  whereNoTokens: ' – aber er enthält keine claude.ai-Tokens (ein API-Key, ein Cloud-Anbieter oder nicht angemeldet)',
  whereRecordNames: (email, account, org) => `Account-Eintrag nennt: ${email} (Account ${account}, Organisation ${org})`,
  whereRecordNone: 'Account-Eintrag nennt: keinen Account',
  whereSavedYes: (who, at, path) => `Im Speicher: ja – ${who}, zuletzt geschrieben ${at} (${path})`,
  whereSavedNot: auto =>
    `Im Speicher: noch nicht – ${auto ? 'er wird mit dem nächsten /account oder binnen 5 Min. gespeichert (autoSave)' : 'autoSave ist aus: /account save'}`,
  whereInStore: (n, names) => `Accounts im Speicher: ${n}${n ? ` (${names})` : ''}`,
  whereAgree: 'Tokens und Account-Eintrag passen zusammen.',
  whereOwner: who => `Die Tokens gehören zu ${who} – der Account-Eintrag nennt einen anderen (der nächste Sync korrigiert das, wo jener gespeichert ist).`,
  whereOtherOwner: key => `einem anderen Account oder einer anderen Organisation (${key})`,
  whereCannotRead: why => `Konnte den Login nicht lesen: ${why}`,
}

const fr: Partial<Messages> = {
  min: n => `${n} min`,
  hmin: (h, m) => `${h} h ${m} min`,
  dh: (d, h) => `${d} j ${h} h`,
  fiveHour: '5 heures',
  sevenDay: '7 jours',
  windowReset: name => `${name} 0 % (fenêtre réinitialisée depuis la lecture)`,
  limit: (name, percent, resetsIn) => `${name} ${percent}${resetsIn ? ` (réinitialisation dans ${resetsIn})` : ''}`,
  noLimits: 'aucune limite 5 heures / 7 jours signalée',
  limitsUnknown: 'limites inconnues',
  limitsNotRead: 'limites pas encore lues',
  readJustNow: 'lu à l’instant',
  readAgo: span => `lu il y a ${span}`,
  full: 'PLEIN',

  nameIt: 'indique le compte : son nom court, e-mail, nom, numéro dans la liste ou uuid',
  fits: (query, n, list) => `« ${query} » correspond à ${n} comptes : ${list} – sois plus précis`,
  noneFits: (query, saved) => `aucun compte enregistré ne correspond à « ${query} »${saved ? ` (enregistrés : ${saved})` : ' – aucun n’est encore enregistré'}`,
  labelTaken: (label, other) => `le nom « ${label} » est déjà pris par ${other} – choisis-en un autre, ou renomme d’abord celui-là`,

  levelAllow: 'changer librement',
  levelAsk: 'demander d’abord',
  levelBlock: 'jamais',
  listMayNot: 'l’IA ne peut PAS passer ici',
  listAsksEnforced: 'l’IA demande d’abord (imposé)',
  listMay: 'l’IA peut passer ici',
  listAsks: 'l’IA demande d’abord',
  alwaysAskRefused: who =>
    `${who} est sur la liste « toujours demander » (option alwaysAsk) : l’IA doit te demander avant d’y passer, et cela ` +
    'ne peut pas être levé ici. Change l’option (ou, si ton organisation l’a fixée, demande-lui).',
  nowAllow: who => `L’IA peut maintenant passer seule à ${who}.`,
  nowAsk: who => `L’IA te demande maintenant avant de passer à ${who}.`,
  nowBlock: who => `L’IA ne peut plus du tout passer à ${who}, même en demandant. Toi, tu le peux toujours (/account switch).`,

  removeActive: who => `${who} est le compte actif et serait aussitôt réenregistré (autoSave). Change d’abord de compte.`,
  removeFailed: (path, why) => `Impossible de supprimer ${path} : ${why}`,
  removed: who => `${who} supprimé (son fichier est effacé ; sa connexion ailleurs n’est pas touchée).`,
  renamed: who => `Renommé : ${who}.`,
  labelled: who => `Nommé : ${who}.`,
  labelRemoved: who => `Nom retiré : ${who}.`,
  saved: (who, path) => `${who} enregistré (${path}).`,
  updated: (who, path) => `${who} mis à jour (${path}).`,
  nothingToSave: 'Pas connecté avec un compte claude.ai – rien à enregistrer.',

  header: (n, active) => `Comptes : ${n} enregistrés · actif : ${active}`,
  activeUnsaved: email => `${email} (non enregistré – /account save)`,
  notSignedIn: 'aucun (pas connecté avec un compte claude.ai)',
  needsLogin: 'NOUVELLE CONNEXION NÉCESSAIRE (son jeton de rafraîchissement a été refusé)',
  couldNotReadAnew: why => `relecture impossible : ${why}`,
  couldNotReadLogin: why => `(Impossible de lire la connexion actuelle : ${why})`,
  mostRoom: (n, name, limits) => `Le plus de marge ailleurs : ${n}. ${name} – ${limits}`,
  noRoom: 'Aucun autre compte avec de la marge connu.',
  onlyOne: 'Un seul compte enregistré : il en faut un autre pour changer (connecte-toi avec via /login – il est enregistré tout seul).',
  userModelMay: cooldown =>
    `L’IA passe seule aux comptes marqués « l’IA peut passer ici »${cooldown > 0 ? ` (au plus toutes les ${cooldown} min)` : ''}, ` +
    'te demande d’abord pour les autres, et ne passe jamais à un compte marqué « l’IA ne peut PAS passer ici ».',
  userModelMayNot: 'L’IA ne peut pas changer de compte seule (/account auto on l’autorise).',

  already: who => `Déjà sur ${who} – rien à changer.`,
  notSavedNoAuto: (email, save) =>
    `le compte connecté (${email}) n’est pas enregistré et autoSave est désactivé – sa connexion serait perdue. Enregistre-le d’abord (/account save, ou ${save}).`,
  cannotSignIn: (who, why) => `${who} ne peut pas être connecté : ${why}`,
  tokenRanOut: (who, why) => `${who} : son jeton a expiré et n’a pas pu être renouvelé (${why}) – réessaie plus tard`,
  writeFailed: (why, restored) =>
    `impossible d’écrire la connexion (${why}) – ` +
    (restored ? 'l’ancienne connexion est rétablie, rien n’a changé' : 'et l’ancienne connexion n’a pas pu être rétablie : reconnecte-toi avec /login'),
  configFailed: (path, why) => `impossible de mettre à jour ${path} (${why}) – l’ancienne connexion est rétablie`,
  didNotHold: 'le changement n’a pas tenu – autre chose a écrit la connexion en même temps ; vérifie avec /account',
  noSavedAccount: 'aucun compte enregistré',
  switched: (from, to, reason) => `Passé de ${from} à ${to}.${reason ? ` Raison : ${reason}` : ''}`,
  itsLimits: (limits, why) => `Ses limites : ${limits}${why ? ` (relecture impossible : ${why})` : ''}.`,
  sessionsFollow:
    'Claude Code utilise la nouvelle connexion dès sa prochaine requête. Toutes les sessions Claude Code de cette machine qui partagent ce dossier de config l’utilisent aussi.',
  toastSwitched: (name, byModel) => `Compte : passé à ${name}${byModel ? ' (par l’IA)' : ''}`,
  toastRecordFixed: name => `Compte : ~/.claude.json indiquait un autre compte que la connexion – remis sur ${name}`,

  askHeader: 'Compte',
  askQuestion: (who, reason) => `Passer le compte Claude à ${who} ? Raison donnée : ${reason}`,
  askSwitch: 'Changer',
  askSwitchHint: 'Changer maintenant ; toutes les sessions Claude Code de cette machine suivent.',
  askStay: 'Ne pas changer',
  askStayHint: 'Rester sur le compte actuel.',

  noteLine: (note, byModel) => `Note${byModel ? ' (par l’IA)' : ''} : ${note}`,
  noteSet: who => `Note enregistrée pour ${who}.`,
  noteRemoved: who => `Note supprimée pour ${who}.`,
  toastNoteByModel: (name, note) => `Compte : l’IA a ${note ? `défini la note de ${name} : ${note}` : `supprimé la note de ${name}`}`,
  toastElsewhere: name => `Compte : maintenant sur ${name} – changé ailleurs (autre session ou /login)`,
  paneNote: 'Note',
  paneSaveNote: 'Enregistrer la note',

  paneTitle: 'Comptes',
  paneHelp: 'Tab / flèches : se déplacer · Entrée : appuyer · Échap : fermer',
  paneReadAnew: 'Relire les limites',
  paneNone: 'Aucun compte enregistré – connecte-toi avec /login, il est enregistré tout seul.',
  paneModel: (level, enforced) => `[IA : ${level}${enforced ? ', imposé' : ''}]`,
  paneActive: 'actif',
  paneSwitchHere: 'Passer ici',
  paneRemove: 'Supprimer',
  paneReallyRemove: 'Vraiment supprimer ? Appuie encore',
  paneName: 'Nom',
  paneRename: 'Renommer',
  paneLegend: 'IA : changer librement = tout de suite · demander d’abord = une boîte de dialogue te demande · jamais = toi seul peux y passer',
  paneReading: 'Compte : lecture des limites de tous les comptes …',
  paneRead: 'Compte : limites lues',
  paneGone: 'déjà supprimé',
  paneSwitched: name => `passé à ${name}`,
  settingsOpened: 'Réglages des comptes ouverts : Tab ou les flèches changent de compte, Entrée change ce que l’IA peut faire, Échap ferme.',

  usage:
    'Utilisation : /account (le panneau) · /account [list|usage|where] · /account allow|ask|block <nom> · /account note <nom> [texte] · /account save [nom] · /account switch <nom> · /account label <nom> <nouveau nom> · /account remove <nom> · /account auto on|off|default',
  autoState: may => `L’IA peut changer seule : ${may ? 'oui' : 'non'}.`,
  autoChanged: may => `L’IA peut changer de compte seule : ${may ? 'oui' : 'non'}.`,
  failed: why => `Account switcher : ${why}`,

  whereSystem: s => `Système : ${s}`,
  whereOther: 'Linux / autre Unix',
  whereHome: h => `Dossier personnel : ${h ?? '(aucun – ni HOME ni USERPROFILE n’est défini)'}`,
  whereConfig: d => `Dossier de config Claude : ${d}`,
  whereKeychain: (service, user) => `Élément du trousseau recherché : « ${service} » (compte « ${user} »)`,
  whereCredentials: (path, mac) => `Fichier d’identifiants${mac ? ' (utilisé si le trousseau n’a pas d’élément)' : ''} : ${path}`,
  whereRecord: path => `Fiche du compte : ${path} (oauthAccount – CTM la lit aussi)`,
  whereStore: path => `Stockage des comptes : ${path}`,
  whereLoginIn: where => `Connexion trouvée dans : ${where}`,
  whereKeychainAt: service => `le trousseau macOS (« ${service} »)`,
  whereBroken: ' – mais elle est CASSÉE (pas de JSON lisible, tronquée par une écriture échouée) : /account switch <un compte enregistré> ou /login la répare',
  whereNoTokens: ' – mais elle ne contient aucun jeton claude.ai (une clé API, un fournisseur cloud, ou pas connecté)',
  whereRecordNames: (email, account, org) => `La fiche du compte indique : ${email} (compte ${account}, organisation ${org})`,
  whereRecordNone: 'La fiche du compte indique : aucun compte',
  whereSavedYes: (who, at, path) => `Enregistré : oui – ${who}, écrit pour la dernière fois ${at} (${path})`,
  whereSavedNot: auto =>
    `Enregistré : pas encore – ${auto ? 'il le sera au prochain /account ou d’ici 5 min (autoSave)' : 'autoSave est désactivé : /account save'}`,
  whereInStore: (n, names) => `Comptes enregistrés : ${n}${n ? ` (${names})` : ''}`,
  whereAgree: 'Les jetons et la fiche du compte concordent.',
  whereOwner: who => `Les jetons appartiennent à ${who} – la fiche indique un autre compte (la prochaine synchronisation corrige là où celui-ci est enregistré).`,
  whereOtherOwner: key => `un autre compte ou une autre organisation (${key})`,
  whereCannotRead: why => `Impossible de lire la connexion : ${why}`,
}

const TABLES: Record<Lang, Partial<Messages>> = { en, de, fr }

// The text for `lang`, else the English one.
export function msg<K extends keyof Messages>(lang: Lang, key: K): Messages[K] {
  return (TABLES[lang][key] ?? en[key]) as Messages[K]
}

// "de_DE.UTF-8", "german", "Deutsch", "fr", "français" … → a language here, else null.
export function langOf(value: string | undefined | null): Lang | null {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return null
  if (/^(de|ger|deu|deutsch)/.test(v)) return 'de'
  if (/^(fr|fra|french|français|francais)/.test(v)) return 'fr'
  if (/^(en|eng)/.test(v)) return 'en'
  return null
}
