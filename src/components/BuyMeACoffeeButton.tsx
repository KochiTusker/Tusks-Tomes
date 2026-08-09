// Floating "Buy Me a Coffee" pill — sits fixed at the bottom-right corner
// of the viewport on every tab. Mirrors the integration in the sister
// project Tusk's Vault: collapsed to a coffee-icon pill by default,
// expands to reveal "Buy me a coffee" on hover with a smooth width
// animation. Yellow BMAC brand color with a soft yellow glow shadow.

import { Coffee } from 'lucide-react'

// Same URL the sister project (Tusk's Vault) uses, so both repos point
// at one canonical BuyMeACoffee page.
export const BMAC_URL = 'https://buymeacoffee.com/kochitusker'

export function BuyMeACoffeeButton() {
  return (
    <a
      href={BMAC_URL}
      target="_blank"
      rel="noreferrer noopener"
      title="Buy Tusk a coffee"
      aria-label="Buy me a coffee"
      className="group fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-[#FFDD00]/90 px-4 py-3 text-sm font-bold text-black shadow-lg shadow-yellow-500/20 backdrop-blur-sm transition-all hover:scale-105 hover:bg-[#FFDD00]"
    >
      <Coffee size={18} aria-hidden />
      <span className="hidden max-w-0 overflow-hidden whitespace-nowrap transition-all duration-300 group-hover:inline-block group-hover:max-w-[160px]">
        Buy me a coffee
      </span>
    </a>
  )
}
