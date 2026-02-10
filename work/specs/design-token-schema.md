# Design Token Schema Specification

**Phase**: 2.6 | **Task**: Pilot AGI-i48
**Consumed by**: Phase 2.7 (Token System), Phase 2.8 (Design Agent), Phase 2.9 (Cross-Platform Export)

---

## Format: W3C DTCG (Design Tokens Community Group)

All tokens follow the W3C Design Tokens Community Group specification.

### Token Structure

```json
{
  "token-name": {
    "$value": "<value>",
    "$type": "<type>",
    "$description": "<optional description>"
  }
}
```

### Supported Types

| Type | Usage | Example Value |
|------|-------|--------------|
| `color` | Any color value | `#3b82f6`, `hsl(222 47% 11%)` |
| `dimension` | Sizes with units | `0.5rem`, `16px` |
| `fontFamily` | Font stacks | `["Inter", "system-ui", "sans-serif"]` |
| `fontWeight` | Font weights | `400`, `700` |
| `duration` | Time values | `150ms`, `300ms` |
| `cubicBezier` | Easing curves | `[0.42, 0.0, 0.58, 1.0]` |
| `number` | Unitless numbers | `1.5`, `1400` |
| `shadow` | Box shadows (composite) | `{color, offsetX, offsetY, blur, spread}` |
| `typography` | Font combos (composite) | `{fontFamily, fontSize, fontWeight, lineHeight}` |
| `border` | Border definitions (composite) | `{color, width, style}` |

### Token References

Tokens can reference other tokens using `{path.to.token}` syntax:
```json
{
  "color": {
    "brand": {
      "primary": {
        "$value": "{color.primitive.blue.600}",
        "$type": "color"
      }
    }
  }
}
```

---

## Three-Tier Architecture

### Tier 1 — Primitive (Raw Values)

Context-free, reusable values. These are the raw design decisions.

### Tier 2 — Semantic (Purpose-Based)

Reference primitives, add meaning. These are what components consume.

### Tier 3 — Component (Optional)

Component-specific overrides. Only used when a component needs to deviate from semantic tokens.

```
Primitive (blue-600)
    ↓ referenced by
Semantic (brand-primary)
    ↓ referenced by
Component (button-primary-bg) [optional]
```

---

## Token Categories

### 1. Colors

```json
{
  "color": {
    "primitive": {
      "blue": {
        "50":  { "$value": "#eff6ff", "$type": "color" },
        "100": { "$value": "#dbeafe", "$type": "color" },
        "200": { "$value": "#bfdbfe", "$type": "color" },
        "300": { "$value": "#93c5fd", "$type": "color" },
        "400": { "$value": "#60a5fa", "$type": "color" },
        "500": { "$value": "#3b82f6", "$type": "color" },
        "600": { "$value": "#2563eb", "$type": "color" },
        "700": { "$value": "#1d4ed8", "$type": "color" },
        "800": { "$value": "#1e40af", "$type": "color" },
        "900": { "$value": "#1e3a8a", "$type": "color" }
      },
      "gray": {
        "50":  { "$value": "#f9fafb", "$type": "color" },
        "100": { "$value": "#f3f4f6", "$type": "color" },
        "200": { "$value": "#e5e7eb", "$type": "color" },
        "300": { "$value": "#d1d5db", "$type": "color" },
        "400": { "$value": "#9ca3af", "$type": "color" },
        "500": { "$value": "#6b7280", "$type": "color" },
        "600": { "$value": "#4b5563", "$type": "color" },
        "700": { "$value": "#374151", "$type": "color" },
        "800": { "$value": "#1f2937", "$type": "color" },
        "900": { "$value": "#111827", "$type": "color" }
      },
      "red": {
        "500": { "$value": "#ef4444", "$type": "color" },
        "600": { "$value": "#dc2626", "$type": "color" }
      },
      "green": {
        "500": { "$value": "#10b981", "$type": "color" },
        "600": { "$value": "#059669", "$type": "color" }
      },
      "amber": {
        "500": { "$value": "#f59e0b", "$type": "color" },
        "600": { "$value": "#d97706", "$type": "color" }
      }
    },
    "semantic": {
      "brand": {
        "primary":   { "$value": "{color.primitive.blue.600}", "$type": "color", "$description": "Primary brand color" },
        "secondary": { "$value": "{color.primitive.blue.400}", "$type": "color" }
      },
      "background": {
        "default": { "$value": "#ffffff", "$type": "color" },
        "subtle":  { "$value": "{color.primitive.gray.50}", "$type": "color" },
        "muted":   { "$value": "{color.primitive.gray.100}", "$type": "color" }
      },
      "foreground": {
        "default": { "$value": "{color.primitive.gray.900}", "$type": "color" },
        "muted":   { "$value": "{color.primitive.gray.500}", "$type": "color" }
      },
      "border": {
        "default": { "$value": "{color.primitive.gray.200}", "$type": "color" },
        "focus":   { "$value": "{color.semantic.brand.primary}", "$type": "color" }
      },
      "state": {
        "success": { "$value": "{color.primitive.green.500}", "$type": "color" },
        "warning": { "$value": "{color.primitive.amber.500}", "$type": "color" },
        "error":   { "$value": "{color.primitive.red.500}", "$type": "color" },
        "info":    { "$value": "{color.semantic.brand.primary}", "$type": "color" }
      }
    }
  }
}
```

### 2. Spacing

```json
{
  "spacing": {
    "0":  { "$value": "0",       "$type": "dimension" },
    "1":  { "$value": "0.25rem", "$type": "dimension", "$description": "4px" },
    "2":  { "$value": "0.5rem",  "$type": "dimension", "$description": "8px" },
    "3":  { "$value": "0.75rem", "$type": "dimension", "$description": "12px" },
    "4":  { "$value": "1rem",    "$type": "dimension", "$description": "16px" },
    "5":  { "$value": "1.25rem", "$type": "dimension", "$description": "20px" },
    "6":  { "$value": "1.5rem",  "$type": "dimension", "$description": "24px" },
    "8":  { "$value": "2rem",    "$type": "dimension", "$description": "32px" },
    "10": { "$value": "2.5rem",  "$type": "dimension", "$description": "40px" },
    "12": { "$value": "3rem",    "$type": "dimension", "$description": "48px" },
    "16": { "$value": "4rem",    "$type": "dimension", "$description": "64px" },
    "20": { "$value": "5rem",    "$type": "dimension", "$description": "80px" },
    "24": { "$value": "6rem",    "$type": "dimension", "$description": "96px" }
  }
}
```

### 3. Typography

```json
{
  "font": {
    "family": {
      "sans": { "$value": ["Inter", "system-ui", "sans-serif"], "$type": "fontFamily" },
      "mono": { "$value": ["Fira Code", "JetBrains Mono", "monospace"], "$type": "fontFamily" }
    },
    "size": {
      "xs":   { "$value": "0.75rem",  "$type": "dimension" },
      "sm":   { "$value": "0.875rem", "$type": "dimension" },
      "base": { "$value": "1rem",     "$type": "dimension" },
      "lg":   { "$value": "1.125rem", "$type": "dimension" },
      "xl":   { "$value": "1.25rem",  "$type": "dimension" },
      "2xl":  { "$value": "1.5rem",   "$type": "dimension" },
      "3xl":  { "$value": "1.875rem", "$type": "dimension" },
      "4xl":  { "$value": "2.25rem",  "$type": "dimension" }
    },
    "weight": {
      "normal":   { "$value": "400", "$type": "fontWeight" },
      "medium":   { "$value": "500", "$type": "fontWeight" },
      "semibold": { "$value": "600", "$type": "fontWeight" },
      "bold":     { "$value": "700", "$type": "fontWeight" }
    },
    "lineHeight": {
      "tight":   { "$value": "1.25",  "$type": "number" },
      "snug":    { "$value": "1.375", "$type": "number" },
      "normal":  { "$value": "1.5",   "$type": "number" },
      "relaxed": { "$value": "1.625", "$type": "number" }
    },
    "letterSpacing": {
      "tight":  { "$value": "-0.025em", "$type": "dimension" },
      "normal": { "$value": "0",        "$type": "dimension" },
      "wide":   { "$value": "0.025em",  "$type": "dimension" }
    }
  },
  "typography": {
    "heading": {
      "h1": {
        "$type": "typography",
        "$value": {
          "fontFamily": "{font.family.sans}",
          "fontSize": "{font.size.4xl}",
          "fontWeight": "{font.weight.bold}",
          "lineHeight": "{font.lineHeight.tight}"
        }
      },
      "h2": {
        "$type": "typography",
        "$value": {
          "fontFamily": "{font.family.sans}",
          "fontSize": "{font.size.2xl}",
          "fontWeight": "{font.weight.semibold}",
          "lineHeight": "{font.lineHeight.tight}"
        }
      }
    },
    "body": {
      "default": {
        "$type": "typography",
        "$value": {
          "fontFamily": "{font.family.sans}",
          "fontSize": "{font.size.base}",
          "fontWeight": "{font.weight.normal}",
          "lineHeight": "{font.lineHeight.normal}"
        }
      },
      "small": {
        "$type": "typography",
        "$value": {
          "fontFamily": "{font.family.sans}",
          "fontSize": "{font.size.sm}",
          "fontWeight": "{font.weight.normal}",
          "lineHeight": "{font.lineHeight.normal}"
        }
      }
    },
    "code": {
      "default": {
        "$type": "typography",
        "$value": {
          "fontFamily": "{font.family.mono}",
          "fontSize": "{font.size.sm}",
          "fontWeight": "{font.weight.normal}",
          "lineHeight": "{font.lineHeight.relaxed}"
        }
      }
    }
  }
}
```

### 4. Shadows

```json
{
  "shadow": {
    "sm": {
      "$type": "shadow",
      "$value": { "color": "#0000000d", "offsetX": "0px", "offsetY": "1px", "blur": "2px", "spread": "0px" }
    },
    "md": {
      "$type": "shadow",
      "$value": [
        { "color": "#0000001a", "offsetX": "0px", "offsetY": "4px", "blur": "6px", "spread": "-1px" },
        { "color": "#0000000d", "offsetX": "0px", "offsetY": "2px", "blur": "4px", "spread": "-1px" }
      ]
    },
    "lg": {
      "$type": "shadow",
      "$value": [
        { "color": "#0000001a", "offsetX": "0px", "offsetY": "10px", "blur": "15px", "spread": "-3px" },
        { "color": "#0000000d", "offsetX": "0px", "offsetY": "4px", "blur": "6px", "spread": "-2px" }
      ]
    }
  }
}
```

### 5. Border Radius

```json
{
  "radius": {
    "none": { "$value": "0",       "$type": "dimension" },
    "sm":   { "$value": "0.375rem", "$type": "dimension" },
    "md":   { "$value": "0.5rem",  "$type": "dimension" },
    "lg":   { "$value": "0.75rem", "$type": "dimension" },
    "xl":   { "$value": "1rem",    "$type": "dimension" },
    "2xl":  { "$value": "1.5rem",  "$type": "dimension" },
    "full": { "$value": "9999px",  "$type": "dimension" }
  }
}
```

### 6. Breakpoints

```json
{
  "breakpoint": {
    "sm":  { "$value": "640px",  "$type": "dimension", "$description": "Small devices" },
    "md":  { "$value": "768px",  "$type": "dimension", "$description": "Medium devices" },
    "lg":  { "$value": "1024px", "$type": "dimension", "$description": "Large devices" },
    "xl":  { "$value": "1280px", "$type": "dimension", "$description": "Extra large" },
    "2xl": { "$value": "1536px", "$type": "dimension", "$description": "2X large" }
  }
}
```

### 7. Z-Index

```json
{
  "zIndex": {
    "hide":     { "$value": "-1",   "$type": "number" },
    "base":     { "$value": "0",    "$type": "number" },
    "dropdown": { "$value": "1000", "$type": "number" },
    "sticky":   { "$value": "1100", "$type": "number" },
    "fixed":    { "$value": "1200", "$type": "number" },
    "overlay":  { "$value": "1300", "$type": "number" },
    "modal":    { "$value": "1400", "$type": "number" },
    "popover":  { "$value": "1500", "$type": "number" },
    "tooltip":  { "$value": "1600", "$type": "number" }
  }
}
```

### 8. Duration (Animation)

```json
{
  "duration": {
    "instant": { "$value": "0ms",   "$type": "duration" },
    "fast":    { "$value": "150ms", "$type": "duration" },
    "normal":  { "$value": "300ms", "$type": "duration" },
    "slow":    { "$value": "500ms", "$type": "duration" }
  }
}
```

### 9. Easing (Animation)

```json
{
  "easing": {
    "linear":    { "$value": [0.0, 0.0, 1.0, 1.0],   "$type": "cubicBezier" },
    "ease":      { "$value": [0.25, 0.1, 0.25, 1.0],  "$type": "cubicBezier" },
    "easeIn":    { "$value": [0.42, 0.0, 1.0, 1.0],   "$type": "cubicBezier" },
    "easeOut":   { "$value": [0.0, 0.0, 0.58, 1.0],   "$type": "cubicBezier" },
    "easeInOut": { "$value": [0.42, 0.0, 0.58, 1.0],  "$type": "cubicBezier" }
  }
}
```

---

## Integration Path

### Token JSON → CSS Custom Properties

```css
:root {
  /* Colors (HSL for shadcn/ui compatibility) */
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --border: 214.3 31.8% 91.4%;
  --ring: 222.2 84% 4.9%;
  --radius: 0.5rem;

  /* Spacing */
  --spacing-1: 0.25rem;
  --spacing-2: 0.5rem;
  --spacing-4: 1rem;
}
```

### CSS Custom Properties → Tailwind Config

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        border: "hsl(var(--border))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      }
    }
  }
}
```

### Tailwind → shadcn/ui Components

shadcn/ui components use Tailwind classes that resolve to CSS custom properties:
```tsx
<Button className="bg-primary text-primary-foreground">Click me</Button>
```

---

## Dark Mode Strategy

Use CSS class-based switching (compatible with shadcn/ui):

```css
.dark {
  --primary: 210 40% 98%;
  --primary-foreground: 222.2 47.4% 11.2%;
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
}
```

Token JSON can include mode variants:
```json
{
  "color": {
    "light": { "background": { "$value": "0 0% 100%", "$type": "color" } },
    "dark":  { "background": { "$value": "222.2 84% 4.9%", "$type": "color" } }
  }
}
```

---

## Validation Rules

1. **Type checking**: Every token must have a valid `$type`
2. **Reference resolution**: All `{path.to.token}` references must resolve to existing tokens
3. **No circular references**: Token A cannot reference Token B which references Token A
4. **Naming convention**: Tokens use dot-separated lowercase paths (`color.semantic.brand.primary`)
5. **Required categories**: A valid token set must include at minimum: colors, spacing, typography, radius

### Validation Script Interface

```typescript
interface ValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;      // Token path
    type: 'missing_type' | 'broken_reference' | 'circular_reference' | 'invalid_value';
    message: string;
  }>;
}

function validateTokens(tokens: object): ValidationResult;
```
