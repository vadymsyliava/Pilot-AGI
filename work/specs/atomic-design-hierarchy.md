# Atomic Design Hierarchy

**Phase**: 2.6 | **Task**: Pilot AGI-i48
**Consumed by**: Phase 2.8 (Design Agent), all AI-generated UI work

---

## The 5 Levels

### Level 1: Atoms

The smallest functional UI units. Cannot be broken down further without losing purpose.

**Characteristics**:
- Zero dependencies on other components
- Direct consumers of design tokens
- Single purpose, highly reusable
- Map 1:1 with HTML elements or shadcn/ui primitives

**Examples**: Button, Input, Label, Badge, Icon, Separator, Avatar, Spinner, Tooltip, Checkbox, Radio

**Props pattern**: `variant`, `size`, `disabled`, `children`, standard HTML attributes

**Folder**: `components/ui/` (shadcn/ui convention)

### Level 2: Molecules

Simple compositions of 2-5 atoms functioning as a unit.

**Characteristics**:
- Composed of atoms only
- Single clear responsibility
- Reusable across different contexts
- No business logic, no API calls

**Examples**: FormField (label+input+error), SearchBar (input+button), StatCard (label+value+trend), AvatarName (avatar+name+role), ButtonGroup, DatePicker

**Folder**: `components/molecules/`

### Level 3: Organisms

Complex UI sections composed of atoms and molecules.

**Characteristics**:
- May have local state and event handlers
- Context-aware (knows about domain)
- Can be standalone features
- May use hooks

**Examples**: Header, Sidebar, DataTable, CommandPalette, Terminal, CodeEditor, NotificationStack, FileTree

**Folder**: `components/organisms/`

### Level 4: Templates

Page-level layouts that define structure without real content.

**Characteristics**:
- Focus on layout, grid, responsive design
- Use placeholder content
- No business logic
- Define responsive breakpoints and spacing

**Examples**: DashboardLayout, AuthLayout, SettingsLayout, SplitLayout, TerminalLayout

**Folder**: `components/templates/`

### Level 5: Pages

Specific instances of templates with real data.

**Characteristics**:
- Represent actual user experiences
- Contain real or realistic content
- Multiple states (loading, error, empty, populated)
- Data fetching and state management live here

**Examples**: Dashboard page, Project overview, Settings page, Terminal session

**Folder**: `app/` routes (Next.js convention)

---

## Dependency Rules

These rules are enforced by the Design Agent (Phase 2.8):

```
Level       | Can Import From        | Cannot Import From
────────────┼────────────────────────┼───────────────────
Atoms       | nothing                | molecules, organisms, templates, pages
Molecules   | atoms                  | organisms, templates, pages
Organisms   | atoms, molecules       | templates, pages
Templates   | organisms              | pages
Pages       | all levels             | —
```

### Enforcement Logic

```typescript
const ALLOWED_IMPORTS: Record<Level, Level[]> = {
  atom:     [],
  molecule: ['atom'],
  organism: ['atom', 'molecule'],
  template: ['organism'],
  page:     ['atom', 'molecule', 'organism', 'template'],
};

function validateImports(component: Component): boolean {
  const allowed = ALLOWED_IMPORTS[component.level];
  return component.dependencies.every(dep => allowed.includes(dep.level));
}
```

---

## Component Registry

Each component is registered with its atomic level and metadata:

```typescript
// components/registry.ts
export interface ComponentEntry {
  path: string;
  level: 'atom' | 'molecule' | 'organism' | 'template';
  category: string;
  dependencies: string[];     // Component names this imports
  tokens: string[];           // Token categories this consumes
  description?: string;
}

export const registry: Record<string, ComponentEntry> = {
  // Atoms
  'button': {
    path: 'components/ui/button.tsx',
    level: 'atom',
    category: 'interaction',
    dependencies: [],
    tokens: ['colors', 'spacing', 'typography', 'radius'],
  },
  'input': {
    path: 'components/ui/input.tsx',
    level: 'atom',
    category: 'form',
    dependencies: [],
    tokens: ['colors', 'spacing', 'typography', 'radius', 'border'],
  },
  'badge': {
    path: 'components/ui/badge.tsx',
    level: 'atom',
    category: 'data-display',
    dependencies: [],
    tokens: ['colors', 'spacing', 'typography', 'radius'],
  },

  // Molecules
  'form-field': {
    path: 'components/molecules/form-field.tsx',
    level: 'molecule',
    category: 'form',
    dependencies: ['label', 'input'],
    tokens: ['spacing'],
  },
  'search-bar': {
    path: 'components/molecules/search-bar.tsx',
    level: 'molecule',
    category: 'interaction',
    dependencies: ['input', 'button', 'icon'],
    tokens: ['spacing'],
  },
  'stat-card': {
    path: 'components/molecules/stat-card.tsx',
    level: 'molecule',
    category: 'data-display',
    dependencies: ['badge', 'icon'],
    tokens: ['spacing', 'colors', 'radius'],
  },

  // Organisms
  'data-table': {
    path: 'components/organisms/data-table.tsx',
    level: 'organism',
    category: 'data-display',
    dependencies: ['button', 'input', 'checkbox', 'badge'],
    tokens: ['spacing', 'colors', 'radius', 'border'],
  },
  'header': {
    path: 'components/organisms/header.tsx',
    level: 'organism',
    category: 'navigation',
    dependencies: ['button', 'avatar', 'search-bar'],
    tokens: ['spacing', 'colors', 'shadow'],
  },

  // Templates
  'dashboard-layout': {
    path: 'components/templates/dashboard-layout.tsx',
    level: 'template',
    category: 'layout',
    dependencies: ['header', 'sidebar'],
    tokens: ['spacing', 'breakpoints'],
  },
};
```

---

## Folder Structure

```
components/
├── ui/                         # Atoms (shadcn/ui convention)
│   ├── button.tsx
│   ├── input.tsx
│   ├── label.tsx
│   ├── badge.tsx
│   ├── checkbox.tsx
│   ├── separator.tsx
│   ├── avatar.tsx
│   ├── spinner.tsx
│   └── tooltip.tsx
│
├── molecules/                  # Composed primitives
│   ├── form-field.tsx
│   ├── search-bar.tsx
│   ├── stat-card.tsx
│   ├── avatar-name.tsx
│   └── button-group.tsx
│
├── organisms/                  # Complex features
│   ├── header.tsx
│   ├── sidebar.tsx
│   ├── data-table/
│   │   ├── index.tsx
│   │   ├── table-header.tsx
│   │   ├── table-row.tsx
│   │   └── table-pagination.tsx
│   ├── command-palette.tsx
│   └── terminal.tsx
│
├── templates/                  # Layout patterns
│   ├── dashboard-layout.tsx
│   ├── auth-layout.tsx
│   └── settings-layout.tsx
│
└── registry.ts                 # Component registry
```

---

## Naming Conventions

| Level | Pattern | Examples |
|-------|---------|---------|
| Atom | Noun, singular | `Button`, `Input`, `Badge` |
| Molecule | Compound noun | `FormField`, `SearchBar`, `StatCard` |
| Organism | Descriptive noun | `Header`, `DataTable`, `Terminal` |
| Template | Context + "Layout" | `DashboardLayout`, `AuthLayout` |
| Page | Route-based | `dashboard/page.tsx`, `settings/page.tsx` |

### File Naming

- kebab-case for files: `form-field.tsx`, `data-table.tsx`
- PascalCase for exports: `FormField`, `DataTable`
- Complex organisms use directory with `index.tsx`

---

## Token Consumption by Level

| Level | Token Usage | Example |
|-------|------------|---------|
| Atoms | Direct token reference | `bg-primary`, `text-sm`, `rounded-md` |
| Molecules | Spacing between atoms | `space-y-2`, `gap-4` |
| Organisms | Semantic layout tokens | `p-6`, `border`, `shadow-md` |
| Templates | Layout + breakpoint tokens | `grid-cols-[250px_1fr]`, responsive breakpoints |
| Pages | No direct token usage | Uses components which use tokens |

---

## AI Agent Rules

When an AI agent creates or modifies components, it must:

1. **Classify level** before creating — determine if it's an atom, molecule, organism, or template
2. **Check registry** — see if a similar component exists before creating new
3. **Validate imports** — only import from allowed levels
4. **Use design tokens** — never hardcode colors, spacing, typography
5. **Follow naming conventions** — kebab-case files, PascalCase exports
6. **Update registry** — add new components to `registry.ts`
7. **Respect folder structure** — place in correct directory for level
