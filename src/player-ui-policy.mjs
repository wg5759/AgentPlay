export const PLAYER_CHROME_HIDE_DELAY_MS = 3000

export function shouldAutoHideControls({ hasMedia = true, playing, blocked = false }) {
  return Boolean(hasMedia && playing && !blocked)
}
