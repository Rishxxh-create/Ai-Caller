# RapidX Voice Studio Interaction Contract

## Visual system

Use the premium Sarvam ivory and gold shell, typography, spacing, border tokens, cards, buttons, transcript bubbles and responsive breakpoints defined in `public/assets/brand.css` and `public/assets/app.css`. White and warm ivory dominate the canvas. Gold is reserved for active navigation, primary actions, selected controls and monetary proof. Avoid dark app surfaces, glassmorphism, decorative gradients and excessive shadows. New controls must use the same tokens rather than introduce a second visual language.

## Talk session model

The Talk surface is a direct voice call, not a push-to-record form or a transcript-driven chat. One primary button starts or ends the session. After start, the agent greets first, listens automatically, handles interruption and turn-taking inside Dograh, responds aloud and resumes listening.

The production path is fixed for the demo: the authenticated Studio backend mints a short-lived Dograh embed session, then browser audio travels over WebRTC into the same published Dograh workflow used by phone calls. Deepgram Nova-3, Groq Llama 3.3 70B, Sarvam Bulbul, VAD, interruption and turn-taking all remain inside that shared call runtime. The UI shows call state and latency, never a live transcript. Stable embed credentials and provider secrets never reach the browser.

Required states:

- `idle`: primary action says **Start conversation**.
- `connecting`: microphone permission and audio pipeline are being prepared.
- `listening`: green live indicator; microphone is actively detecting speech.
- `thinking`: the agent is generating its response; typing bubble is visible.
- `speaking`: the Sarvam response is playing; listening resumes when playback ends.
- `error`: a specific recoverable message is shown and the session may be restarted.

## Interaction and accessibility

- The session state must be visible as text, color cannot be the only signal.
- The primary session button must have a stable accessible name and at least a 44 px target.
- Requests must time out and remove loading indicators on every success or failure path.
- Microphone capture uses echo cancellation, noise suppression and automatic gain control when supported.
- Ending the session stops every media track, timer, recorder, audio context and playing response.
- Respect `prefers-reduced-motion` by disabling pulse animation.

## Responsive behavior

The animated voice stage remains the dominant surface. At tablet/mobile widths, the session controls wrap into one clear full-width action.

## Demo link surfaces

The authenticated Demo links section uses the same ivory cards, gold primary action, text-safe status pills and 44 px controls as the rest of Studio. A link creation form must name the selected agent and expose only server-owned expiry, duration and start-count limits. The secret URL is presented once and retained only in the current browser session because the server stores a SHA-256 hash, never a recoverable token.

The public demo page is tenant branded but intentionally isolated from account navigation, billing, provider configuration and admin data. Its states are `loading`, `idle`, `connecting`, `listening`, `thinking`, `speaking`, `ended` and `error`. Text accompanies every state, the visitor can always end an active call, expiry and revocation fail closed, and mobile keeps one full-width primary action. Public copy stays provider and model neutral because tenants may change their runtime configuration.
