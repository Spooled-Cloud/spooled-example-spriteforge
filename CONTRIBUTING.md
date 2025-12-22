# Contributing to SpriteForge

Thank you for your interest in contributing to SpriteForge! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and constructive in all interactions. We're building something cool together.

## Getting Started

### Prerequisites

- Node.js 20+
- A Spooled Cloud API key (get one at [dashboard.spooled.cloud](https://dashboard.spooled.cloud))
- Docker (optional, for container testing)

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/spooled-example-spriteforge.git
cd spooled-example-spriteforge

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env and add your API key

# Start development server
npm run dev
```

## Making Changes

### Branch Naming

Use descriptive branch names:
- `feature/add-new-palette` - New features
- `fix/sse-reconnection` - Bug fixes
- `docs/update-readme` - Documentation
- `refactor/cleanup-workers` - Code refactoring

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add midnight color palette
fix: handle SSE disconnection gracefully
docs: update deployment instructions
refactor: simplify worker registration
chore: update dependencies
```

### Code Style

- Use ES modules (`.mjs` files)
- 2-space indentation
- Single quotes for strings
- No semicolons (we use the no-semi style)
- Descriptive variable names

### Testing Your Changes

1. **Local testing**: Run `npm run dev` and test in browser
2. **Docker testing**: Run `docker compose up --build`
3. **Chaos mode**: Set chaos slider to 30%+ to test retry behavior

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** from `main`
3. **Make your changes** with clear commits
4. **Test thoroughly** (local + Docker)
5. **Update documentation** if needed
6. **Open a PR** with a clear description

### PR Description Template

```markdown
## What

Brief description of the change.

## Why

Why is this change needed?

## How

How was it implemented?

## Testing

How did you test this?

## Screenshots (if UI changes)

Before/After screenshots if applicable.
```

## Project Structure

```
├── public/           # Frontend assets (served statically)
│   ├── index.html    # Main HTML
│   ├── styles.css    # All styles
│   └── app.js        # Frontend JavaScript
├── server/
│   ├── server.mjs    # Express server, SSE, workers
│   └── spriteforge.mjs # Pixel art generation logic
├── k8s/              # Kubernetes manifests
└── .github/          # CI/CD workflows
```

## Key Concepts

### Workers

The server starts 3 worker types:
- **Frame worker**: Generates individual animation frames
- **Assemble worker**: Combines frames into final sprite
- **Public worker**: Processes scheduled "Sprite of the Minute" jobs

### Real-time Events

Event flow: Spooled → WebSocket → Server → SSE → Browser

Sessions are tracked to route events to the correct browser tab.

### Pixel Art Generation

The `spriteforge.mjs` module uses a seeded random generator to create deterministic pixel art based on:
- Seed string (for reproducibility)
- Color palette
- Animation type
- Frame index

## Questions?

- Open a [GitHub Issue](https://github.com/spooled-cloud/spooled-example-spriteforge/issues)
- Check [Spooled Documentation](https://spooled.cloud/docs)

Thank you for contributing! 🎨
