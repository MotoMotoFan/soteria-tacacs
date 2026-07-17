# Soteria Frontend

Web management interface for the Soteria TACACS+ server.

**UI/UX only** — backend integration will be added in the future.

## Setup

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Asset Setup

Copy logos from the `pathfinder-website` project:

```bash
cp ../pathfinder-website/public/assets/media-logo.png public/assets/
cp ../pathfinder-website/public/assets/logo-negative.png public/assets/
cp ../pathfinder-website/public/assets/negative-name.png public/assets/
```

## Structure

```
src/
├── components/     # Shared UI components (Sidebar, TopBar, Modal)
├── data/           # Mock data (replaced by API calls later)
├── layouts/        # Dashboard layout with sidebar + topbar
└── pages/          # Route pages
    ├── Dashboard   # Overview stats, recent logs, system status
    ├── Users       # User CRUD, group assignment, password management
    ├── Devices     # Network device (NAS) management
    ├── Groups      # Group definitions (local + LDAP)
    ├── Profiles    # Authorization profiles, privilege levels
    ├── Rulesets    # Group-to-profile mapping rules
    ├── Logs        # AAA log viewer with filters
    ├── Config      # Edit/Commit/Rollback workflow, file viewer
    └── Settings    # Server, TLS, LDAP, DNS, Agent config
```

## Tech Stack

React 18, TypeScript, Vite, Tailwind CSS, React Router, Lucide Icons.

## Credits

- **Soteria** — Pathfinder Insights, engineered by MotoMotoFan
