<div align="center">
  <img src="./public/favicon.svg" width="64" height="64" alt="GATHR mark" />
  <h1>gathr</h1>
  <p><strong>Paperwork, brought into order.</strong></p>
  <p>Invoice intake and document workflow for accountants, bookkeepers, and finance teams.</p>
  <p>
    <img src="https://img.shields.io/badge/status-early%20prototype-777870?style=flat-square" alt="Early prototype" />
    <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white" alt="React 19" />
    <img src="https://img.shields.io/badge/TanStack%20Start-1.168-FF4154?style=flat-square" alt="TanStack Start" />
    <img src="https://img.shields.io/badge/Database-Neon%20Postgres-00E599?style=flat-square" alt="Neon Postgres" />
  </p>
</div>

---

## Overview

GATHR is being built to make invoice intake less fragmented. The product direction is simple: bring combined PDFs and individual invoices into one workspace, identify the information that matters, review uncertain details, and organize records for downstream accounting work.

**Less sorting. Less manual work. More clarity.**

## Project status

> [!IMPORTANT]
> **GATHR is an early-stage prototype.** The current upload and processing experience is a demonstration: selected PDFs stay in the browser, are not read or uploaded, and the processing flow generates sample invoice data. Workspace records currently live in client-side in-memory state. Do not use real client documents or rely on prototype outputs for accounting decisions.

The authentication foundation is integrated separately using Better Auth and Neon. Email verification is wired through Resend's development test mode, which routes OTP messages to a configured test inbox. A verified sending domain and production deployment configuration are still required before customer-facing use.

## Product direction

The workflow GATHR is designed to support:

1. **Gather** — bring combined PDFs and individual invoices into one place.
2. **Review** — identify invoice boundaries and important financial fields, then inspect uncertain values.
3. **Organize** — flag duplicate candidates, apply consistent filenames, and prepare structured exports.

Planned document fields include supplier details, GSTIN, invoice number and dates, taxable value, CGST, SGST, IGST, and invoice total.

## Prototype capabilities

The current codebase includes:

- Marketing pages for the product, features, workflow, and pricing concept.
- An authenticated workspace shell and dashboard.
- Email/password authentication and Google OAuth configuration through Better Auth.
- Email OTP verification through Resend's API.
- Session-backed access checks for workspace routes.
- PDF selection and upload interface for the demonstration flow.
- Demo invoice review screens, status changes, and export UI.

Some interface elements describe intended product capabilities rather than live processing. See [Project status](#project-status) before evaluating the prototype.

## Technology

| Area | Technology |
| --- | --- |
| Application | TanStack Start, React 19, TypeScript |
| Build tooling | Vite, Nitro |
| Styling | Tailwind CSS 4 |
| UI | Radix UI, shadcn-style components, Lucide |
| Authentication | Better Auth |
| Database | Neon PostgreSQL |
| Database connectivity | `@neondatabase/serverless` |
| Email delivery | Resend |
| Validation and forms | Zod, React Hook Form |

## Getting started

### Requirements

- Node.js and npm
- A Neon PostgreSQL development database
- Better Auth environment variables
- A Resend API key for email OTP testing
- Google OAuth credentials if testing Google sign-in

### 1. Clone the repository

This repository is private. Your GitHub account must have access.

```bash
git clone https://github.com/vikasaurous/gathr.git
cd gathr
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the example file:

**Windows PowerShell**
```powershell
Copy-Item .env.example .env.local
```

**macOS / Linux**
```bash
cp .env.example .env.local
```

Fill in the values locally. Never commit `.env.local`.

Generate a Better Auth secret with Node.js:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

For local email testing, Resend's shared testing sender only delivers to the verified email address associated with the Resend account. GATHR's development test mode can route OTP messages to the configured test inbox; the original GATHR account email remains the identity being verified.

Google sign-in also requires a Google OAuth web client configured with the local callback:

```text
http://localhost:8080/api/auth/callback/google
```

### 4. Start the development server

```bash
npm run dev
```

Open the local URL printed by Vite. The configured development origin is currently `http://localhost:8080`.

## Environment variables

See [.env.example](./.env.example) for the complete local template.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon PostgreSQL connection string for the development branch |
| `BETTER_AUTH_SECRET` | Secret used by Better Auth |
| `BETTER_AUTH_URL` | Canonical application origin |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth web client secret |
| `RESEND_API_KEY` | Server-side Resend API key |
| `RESEND_FROM_EMAIL` | Email sender identity |
| `RESEND_TEST_MODE` | Enables development-only recipient routing |
| `RESEND_TEST_RECIPIENT` | Verified Resend test inbox |
| `ADMIN_EMAILS` | Comma-separated verified emails allowed to open `/admin` (empty = admin disabled) |

Keep secrets out of browser code, commits, screenshots, and issue reports. Do not use a `VITE_` prefix for server-side credentials.

## Available scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start local development server |
| `npm run build` | Build client, SSR, and Nitro output |
| `npm run preview` | Preview production build |
| `npm run lint` | Run ESLint |
| `npm test` | Run Vitest once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run format` | Format project files with Prettier |

## Repository structure

```text
gathr/
├── public/                 # Static assets and favicon
├── scripts/                # Database and email diagnostics
├── src/
│   ├── components/
│   │   ├── gathr/          # Product-specific UI
│   │   └── ui/             # Reusable interface primitives
│   ├── lib/
│   │   ├── auth/           # Better Auth client, server, and helpers
│   │   ├── email/          # Resend email delivery
│   │   └── gathr/          # Workspace prototype and demo data
│   ├── routes/             # TanStack file-based routes
│   ├── styles.css
│   ├── router.tsx
│   ├── server.ts
│   └── start.ts
├── .env.example
├── package.json
└── README.md
```

## Development notes

- Use the Neon `development` branch for local work. Never run local migrations against production.
- The current workspace store is in-memory; data does not persist across reloads.
- The current PDF workflow is simulated. Real document storage, parsing, extraction, and background processing are not connected yet.
- Resend development mode is for testing only. Production email requires a verified sending domain and production secrets.
- Google OAuth local credentials are separate from production OAuth configuration.
- Generated TanStack route files should be updated by the router tooling, not edited by hand.

## Useful documentation

- [TanStack Start](https://tanstack.com/start/latest/docs)
- [TanStack Router](https://tanstack.com/router/latest/docs)
- [React](https://react.dev/)
- [TypeScript](https://www.typescriptlang.org/docs/)
- [Vite](https://vite.dev/guide/)
- [Tailwind CSS](https://tailwindcss.com/docs)
- [Better Auth](https://www.better-auth.com/docs)
- [Neon](https://neon.com/docs)
- [Resend](https://resend.com/docs)

---

<div align="center">
  <sub>Built for clearer invoice workflows. GATHR is under active development.</sub>
</div>
