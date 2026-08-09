// Floating "Share feedback" pill — sits fixed at the bottom-right corner
// of the viewport, stacked just above the BuyMeACoffeeButton. Mirrors the
// BMAC pattern: collapsed to a message-icon pill by default, expands to
// reveal "Share feedback" on hover with a smooth width animation. Native
// title tooltip on hover ("Share your thoughts!") for users who hover but
// don't see the expanded label.
//
// Points at the project's Google Form — the interim feedback channel
// until the community Discord on the roadmap launches.

import { MessageSquare } from 'lucide-react'

export const FEEDBACK_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header'

export function FeedbackButton() {
  return (
    <a
      href={FEEDBACK_URL}
      target="_blank"
      rel="noreferrer noopener"
      title="Share your thoughts!"
      aria-label="Share feedback"
      className="group fixed bottom-20 right-6 z-40 flex items-center gap-2 rounded-full bg-[#4285F4]/90 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/20 backdrop-blur-sm transition-all hover:scale-105 hover:bg-[#4285F4]"
    >
      <MessageSquare size={18} aria-hidden />
      <span className="hidden max-w-0 overflow-hidden whitespace-nowrap transition-all duration-300 group-hover:inline-block group-hover:max-w-[160px]">
        Share feedback
      </span>
    </a>
  )
}
