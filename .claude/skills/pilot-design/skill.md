---
name: pilot-design
description: Create/update design system with design tokens, core components, and showcase page. Uses shadcn/ui and creates component registry.
argument-hint: [action - setup | add <component> | showcase | tokens]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion
---

# Design System Generator

You are creating or updating a design system for the project.

## Arguments

`$ARGUMENTS` can be:
- Empty or `setup` - Full design system setup
- `add <component>` - Add a specific component
- `showcase` - Generate/update showcase page
- `tokens` - Update design tokens only

## Prerequisites Check

Before starting, verify:
1. Project has Next.js/React configured
2. Tailwind CSS is installed
3. TypeScript is configured

```bash
# Quick check
ls package.json tsconfig.json tailwind.config.* 2>/dev/null
```

If not configured, inform user and offer to help setup.

## Step 1: Check Existing Design System

```bash
# Check for existing design system
ls -la src/components/ui/ 2>/dev/null || echo "No ui/ directory"
ls -la src/styles/ 2>/dev/null || echo "No styles/ directory"
cat .claude/pilot/component-registry.json 2>/dev/null || echo "No component registry"
```

Report what exists and what needs to be created.

## Step 2: Design Tokens Setup

### 2.1 Create tokens CSS file

Create `src/styles/tokens.css` with CSS custom properties:

```css
:root {
  /* Colors - Base */
  --color-background: 0 0% 100%;
  --color-foreground: 222 47% 11%;

  /* Colors - Primary */
  --color-primary: 222 47% 11%;
  --color-primary-foreground: 210 40% 98%;

  /* Colors - Secondary */
  --color-secondary: 210 40% 96%;
  --color-secondary-foreground: 222 47% 11%;

  /* Colors - Muted */
  --color-muted: 210 40% 96%;
  --color-muted-foreground: 215 16% 47%;

  /* Colors - Accent */
  --color-accent: 210 40% 96%;
  --color-accent-foreground: 222 47% 11%;

  /* Colors - Destructive */
  --color-destructive: 0 84% 60%;
  --color-destructive-foreground: 210 40% 98%;

  /* Colors - Border/Input/Ring */
  --color-border: 214 32% 91%;
  --color-input: 214 32% 91%;
  --color-ring: 222 47% 11%;

  /* Typography Scale */
  --font-sans: ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, monospace;

  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.25rem;
  --text-2xl: 1.5rem;
  --text-3xl: 1.875rem;
  --text-4xl: 2.25rem;

  /* Spacing Scale (4px base) */
  --spacing-0: 0;
  --spacing-1: 0.25rem;
  --spacing-2: 0.5rem;
  --spacing-3: 0.75rem;
  --spacing-4: 1rem;
  --spacing-5: 1.25rem;
  --spacing-6: 1.5rem;
  --spacing-8: 2rem;
  --spacing-10: 2.5rem;
  --spacing-12: 3rem;
  --spacing-16: 4rem;

  /* Border Radius */
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);

  /* Transitions */
  --transition-fast: 150ms;
  --transition-normal: 200ms;
  --transition-slow: 300ms;
}

/* Dark mode */
.dark {
  --color-background: 222 47% 11%;
  --color-foreground: 210 40% 98%;

  --color-primary: 210 40% 98%;
  --color-primary-foreground: 222 47% 11%;

  --color-secondary: 217 33% 17%;
  --color-secondary-foreground: 210 40% 98%;

  --color-muted: 217 33% 17%;
  --color-muted-foreground: 215 20% 65%;

  --color-accent: 217 33% 17%;
  --color-accent-foreground: 210 40% 98%;

  --color-destructive: 0 62% 30%;
  --color-destructive-foreground: 210 40% 98%;

  --color-border: 217 33% 17%;
  --color-input: 217 33% 17%;
  --color-ring: 212 100% 67%;
}
```

### 2.2 Update Tailwind config

Ensure `tailwind.config.ts` uses CSS variables:

```typescript
import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--color-background))",
        foreground: "hsl(var(--color-foreground))",
        primary: {
          DEFAULT: "hsl(var(--color-primary))",
          foreground: "hsl(var(--color-primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--color-secondary))",
          foreground: "hsl(var(--color-secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--color-muted))",
          foreground: "hsl(var(--color-muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--color-accent))",
          foreground: "hsl(var(--color-accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--color-destructive))",
          foreground: "hsl(var(--color-destructive-foreground))",
        },
        border: "hsl(var(--color-border))",
        input: "hsl(var(--color-input))",
        ring: "hsl(var(--color-ring))",
      },
      borderRadius: {
        lg: "var(--radius-lg)",
        md: "var(--radius-md)",
        sm: "var(--radius-sm)",
      },
    },
  },
  plugins: [],
};

export default config;
```

## Step 3: Setup shadcn/ui

If not already installed:

```bash
# Initialize shadcn/ui
npx shadcn@latest init
```

When prompted:
- Style: Default
- Base color: Slate
- CSS variables: Yes
- React Server Components: Yes
- Components path: src/components/ui
- Utilities path: src/lib/utils

Then install core components:

```bash
npx shadcn@latest add button input card
```

## Step 4: Core Components

Ensure these core components exist (via shadcn or custom):

### Essential Components
| Component | Purpose | Variants |
|-----------|---------|----------|
| Button | Actions | primary, secondary, outline, ghost, destructive |
| Input | Text entry | text, email, password, number |
| Card | Content container | with header/content/footer |
| Badge | Status indicator | default, secondary, destructive, outline |
| Alert | Feedback messages | default, destructive |

### Form Components
| Component | Purpose |
|-----------|---------|
| Select | Dropdown selection |
| Checkbox | Boolean toggle |
| Radio | Single selection |
| Switch | On/off toggle |
| Textarea | Multi-line text |

### Layout Components
| Component | Purpose |
|-----------|---------|
| Dialog/Modal | Overlays |
| Sheet | Side panels |
| Separator | Visual divider |

For each missing component, run:
```bash
npx shadcn@latest add <component-name>
```

## Step 5: Component Registry

Create/update `.claude/pilot/component-registry.json`:

```json
{
  "version": "1.0.0",
  "lastUpdated": "YYYY-MM-DD",
  "components": {
    "Button": {
      "path": "src/components/ui/button.tsx",
      "source": "shadcn",
      "variants": ["default", "secondary", "outline", "ghost", "destructive", "link"],
      "sizes": ["default", "sm", "lg", "icon"],
      "props": ["asChild", "disabled"]
    },
    "Input": {
      "path": "src/components/ui/input.tsx",
      "source": "shadcn",
      "types": ["text", "email", "password", "number", "search"],
      "props": ["disabled", "placeholder"]
    },
    "Card": {
      "path": "src/components/ui/card.tsx",
      "source": "shadcn",
      "subcomponents": ["Card", "CardHeader", "CardTitle", "CardDescription", "CardContent", "CardFooter"]
    }
  },
  "patterns": {
    "form-field": "Use FormField from react-hook-form with Label + Input + FormMessage",
    "loading-state": "Use Skeleton or spinner inside component with isLoading prop",
    "error-state": "Use Alert variant='destructive' for error messages",
    "data-fetching": "Use Server Components for initial data, SWR for client mutations"
  },
  "rules": {
    "no-duplicate-components": "Always check registry before creating new UI component",
    "use-design-tokens": "Never use hardcoded colors or spacing, use CSS variables or Tailwind classes",
    "accessibility": "All interactive elements must be keyboard accessible with proper ARIA labels"
  }
}
```

## Step 6: Design System Showcase Page

Create `src/app/design-system/page.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";

export default function DesignSystemPage() {
  return (
    <div className="container mx-auto py-10 space-y-16">
      <header>
        <h1 className="text-4xl font-bold">Design System</h1>
        <p className="text-muted-foreground mt-2">
          Component library and design tokens for this project.
        </p>
      </header>

      {/* Colors Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-6">Colors</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <ColorSwatch name="Background" className="bg-background border" />
          <ColorSwatch name="Foreground" className="bg-foreground" />
          <ColorSwatch name="Primary" className="bg-primary" />
          <ColorSwatch name="Secondary" className="bg-secondary" />
          <ColorSwatch name="Muted" className="bg-muted" />
          <ColorSwatch name="Accent" className="bg-accent" />
          <ColorSwatch name="Destructive" className="bg-destructive" />
          <ColorSwatch name="Border" className="bg-border" />
        </div>
      </section>

      <Separator />

      {/* Typography Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-6">Typography</h2>
        <div className="space-y-4">
          <p className="text-4xl font-bold">Heading 1 (4xl bold)</p>
          <p className="text-3xl font-semibold">Heading 2 (3xl semibold)</p>
          <p className="text-2xl font-semibold">Heading 3 (2xl semibold)</p>
          <p className="text-xl font-medium">Heading 4 (xl medium)</p>
          <p className="text-base">Body text (base)</p>
          <p className="text-sm text-muted-foreground">Small text / muted</p>
          <p className="text-xs text-muted-foreground">Extra small / caption</p>
        </div>
      </section>

      <Separator />

      {/* Buttons Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-6">Buttons</h2>
        <div className="flex flex-wrap gap-4">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="flex flex-wrap gap-4 mt-4">
          <Button size="sm">Small</Button>
          <Button size="default">Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon">
            <span>+</span>
          </Button>
        </div>
        <div className="flex flex-wrap gap-4 mt-4">
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <Separator />

      {/* Inputs Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-6">Inputs</h2>
        <div className="grid gap-4 max-w-md">
          <Input placeholder="Default input" />
          <Input type="email" placeholder="Email input" />
          <Input type="password" placeholder="Password input" />
          <Input disabled placeholder="Disabled input" />
        </div>
      </section>

      <Separator />

      {/* Cards Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-6">Cards</h2>
        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Card Title</CardTitle>
              <CardDescription>Card description goes here</CardDescription>
            </CardHeader>
            <CardContent>
              <p>Card content with some example text.</p>
            </CardContent>
            <CardFooter>
              <Button>Action</Button>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Simple Card</CardTitle>
            </CardHeader>
            <CardContent>
              <p>A card without description or footer.</p>
            </CardContent>
          </Card>
        </div>
      </section>

      <Separator />

      {/* Badges Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-6">Badges</h2>
        <div className="flex flex-wrap gap-4">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </div>
      </section>

      <Separator />

      {/* Alerts Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-6">Alerts</h2>
        <div className="space-y-4 max-w-xl">
          <Alert>
            <AlertTitle>Default Alert</AlertTitle>
            <AlertDescription>
              This is a default alert message.
            </AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              This is a destructive alert for errors.
            </AlertDescription>
          </Alert>
        </div>
      </section>

      <Separator />

      {/* Spacing Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-6">Spacing Scale</h2>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => (
            <div key={n} className="flex items-center gap-4">
              <span className="w-12 text-sm text-muted-foreground">space-{n}</span>
              <div className={`h-4 bg-primary`} style={{ width: `${n * 0.25}rem` }} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ColorSwatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="space-y-2">
      <div className={`h-16 rounded-lg ${className}`} />
      <p className="text-sm font-medium">{name}</p>
    </div>
  );
}
```

## Step 7: Verification

After setup, verify:

1. **Dev Server**: `npm run dev` - should start without errors
2. **Design System Page**: Visit `/design-system` - all components render
3. **Dark Mode**: Add `dark` class to html - colors switch correctly
4. **Component Registry**: `.claude/pilot/component-registry.json` exists and is accurate

## Step 8: User Approval

Display summary:

```
DESIGN SYSTEM SETUP COMPLETE
--------------------------------------------------------------------

  Created/Updated:
  - src/styles/tokens.css (design tokens)
  - tailwind.config.ts (extended with tokens)
  - src/components/ui/ (shadcn components)
  - src/app/design-system/page.tsx (showcase)
  - .claude/pilot/component-registry.json (registry)

  Core Components:
  - Button (6 variants, 4 sizes)
  - Input (4 types)
  - Card (with subcomponents)
  - Badge (4 variants)
  - Alert (2 variants)

  Next Steps:
  1. Visit http://localhost:3000/design-system
  2. Review components and colors
  3. Approve or request changes

--------------------------------------------------------------------
```

**CRITICAL**: Wait for user to review the design system page before proceeding with feature development.

## Adding New Components

When `$ARGUMENTS` is `add <component>`:

1. Check if component exists in registry
2. If shadcn has it: `npx shadcn@latest add <component>`
3. Update component-registry.json
4. Add to design system showcase page
5. Verify it renders correctly

## Important Rules

- ALWAYS check component-registry.json before creating new components
- NEVER use hardcoded colors - use design tokens or Tailwind classes
- ALWAYS ensure components are accessible (keyboard nav, ARIA labels)
- ALWAYS update the showcase page when adding components
- Get user approval on design system BEFORE building features
