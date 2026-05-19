# MAGI Control System (Next.js)

Tri-core interface for coordinating OpenAI, Anthropic, and Grok providers to reduce hallucinations when asking nuanced questions.

## Quickstart

1) Install dependencies:
```bash
npm install
```

2) Create `.env.local` in the project root:
```bash
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
NEXT_PUBLIC_SITE_URL=https://magi.bandors.org
# Server-side only; do NOT expose to browser
SUPABASE_SERVICE_ROLE_KEY=<your-service-role>
STRIPE_SECRET_KEY=<your-stripe-secret-key>
STRIPE_WEBHOOK_SECRET=<your-stripe-webhook-secret>
STRIPE_PRICE_ID=<your-stripe-price-id>
```

3) Run the dev server:
```bash
npm run dev
```

Open `http://localhost:3000` in a desktop browser.

## Notes
- The MAGI UI is desktop-first.
- Provider API keys are stored in browser session storage.
- Supabase Auth gates the dashboard; unauthenticated visitors see the interface behind a login/register overlay.

## Structure
- `app/` - Next.js App Router pages and global layout
- `components/` - UI components (`MagiPanel`, `KeyInput`, `StatusLamp`)
- `lib/` - utilities (`localStore`, `supabaseClient`)
