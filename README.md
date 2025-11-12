# MAGI Operator Console (Next.js)

Evangelion-inspired tri-core operator interface for coordinating OpenAI, Anthropic, and Grok providers for code auditing.

## Quickstart

1) Install dependencies:
```bash
npm install
```

2) Create `.env.local` in the project root:
```bash
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
# Server-side only; do NOT expose to browser
SUPABASE_SERVICE_ROLE_KEY=<your-service-role>
```

3) Run the dev server:
```bash
npm run dev
```

Open `http://localhost:3000` in a desktop browser.

## Notes
- The operator UI is desktop-first.
- API keys are stored locally in `localStorage` for this initial UI-only build.
- Supabase client is prepared for future secure storage once login/auth is added.

## Structure
- `app/` - Next.js App Router pages and global layout
- `components/` - UI components (`MagiPanel`, `KeyInput`, `StatusLamp`)
- `lib/` - utilities (`localStore`, `supabaseClient`)


