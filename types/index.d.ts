// What the account settings pane draws: one row per saved account.
// level: what the model may do – switch on its own, ask first, or not at all.
export type AccountRow = {
  key: string
  name: string
  who: string
  level: 'allow' | 'ask' | 'block'
  enforced: boolean
  active: boolean
  limits: string
}

declare module 'claude-code' {
  interface PluginState {
    'account-switcher': { rows: Shaped<AccountRow[]> }
  }
}
