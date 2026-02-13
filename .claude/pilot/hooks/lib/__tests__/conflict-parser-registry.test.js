/**
 * Tests for ConflictParserRegistry — Phase 5.2
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Fresh module pattern
function freshModule() {
  const modPath = require.resolve('../conflict-parser-registry');
  delete require.cache[modPath];
  return require(modPath);
}

describe('ConflictParserRegistry', () => {
  let mod;

  beforeEach(() => {
    mod = freshModule();
    mod.resetRegistry();
  });

  describe('LANG_PROFILES', () => {
    it('should define profiles for all target languages', () => {
      const langs = Object.keys(mod.LANG_PROFILES);
      assert.ok(langs.includes('javascript'));
      assert.ok(langs.includes('typescript'));
      assert.ok(langs.includes('python'));
      assert.ok(langs.includes('go'));
      assert.ok(langs.includes('rust'));
    });

    it('should have extensions for each profile', () => {
      for (const profile of Object.values(mod.LANG_PROFILES)) {
        assert.ok(profile.extensions.length > 0, `${profile.name} should have extensions`);
        assert.ok(profile.declarationPatterns.length > 0, `${profile.name} should have declarationPatterns`);
        assert.ok(profile.importPatterns.length > 0, `${profile.name} should have importPatterns`);
      }
    });
  });

  describe('Registry', () => {
    it('should auto-register all built-in profiles', () => {
      const registry = mod.getRegistry();
      const languages = registry.getLanguages();
      assert.ok(languages.length >= 5);
      assert.ok(languages.includes('javascript'));
    });

    it('should look up by extension', () => {
      const registry = mod.getRegistry();
      assert.strictEqual(registry.getByExtension('.js').name, 'javascript');
      assert.strictEqual(registry.getByExtension('.ts').name, 'typescript');
      assert.strictEqual(registry.getByExtension('.py').name, 'python');
      assert.strictEqual(registry.getByExtension('.go').name, 'go');
      assert.strictEqual(registry.getByExtension('.rs').name, 'rust');
    });

    it('should look up by file path', () => {
      const registry = mod.getRegistry();
      assert.strictEqual(registry.getByFilePath('src/index.js').name, 'javascript');
      assert.strictEqual(registry.getByFilePath('lib/parser.ts').name, 'typescript');
      assert.strictEqual(registry.getByFilePath('main.py').name, 'python');
    });

    it('should return null for unsupported extensions', () => {
      const registry = mod.getRegistry();
      assert.strictEqual(registry.getByExtension('.java'), null);
      assert.strictEqual(registry.getByExtension('.rb'), null);
    });

    it('should check if file is supported', () => {
      const registry = mod.getRegistry();
      assert.ok(registry.isSupported('index.js'));
      assert.ok(registry.isSupported('main.go'));
      assert.ok(!registry.isSupported('Main.java'));
    });

    it('should list all supported extensions', () => {
      const registry = mod.getRegistry();
      const exts = registry.getSupportedExtensions();
      assert.ok(exts.includes('.js'));
      assert.ok(exts.includes('.ts'));
      assert.ok(exts.includes('.py'));
    });

    it('should allow custom profile registration', () => {
      const registry = mod.getRegistry();
      registry.register({
        name: 'ruby',
        extensions: ['.rb'],
        declarationPatterns: [/^def\s+(\w+)/],
        importPatterns: [/^require\s+/],
        classPatterns: [/^class\s+(\w+)/],
        blockStart: /\bdo\b|\{/,
        blockEnd: /\bend\b|\}/,
        importsCommutative: true
      });
      assert.strictEqual(registry.getByExtension('.rb').name, 'ruby');
    });

    it('should throw on missing profile name', () => {
      const registry = mod.getRegistry();
      assert.throws(() => registry.register({}), /must have a name/);
    });

    it('should reset properly', () => {
      mod.resetRegistry();
      const registry = mod.getRegistry();
      assert.ok(registry.getLanguages().length >= 5);
    });
  });

  describe('extractRegions', () => {
    it('should extract JS function declarations', () => {
      const profile = mod.LANG_PROFILES.javascript;
      const source = `const a = 1;

function foo() {
  return 1;
}

function bar() {
  return 2;
}`;
      const regions = mod.extractRegions(source, profile);
      const declNames = regions.filter(r => r.type === 'declaration').map(r => r.name);
      assert.ok(declNames.includes('foo'));
      assert.ok(declNames.includes('bar'));
    });

    it('should extract import blocks', () => {
      const profile = mod.LANG_PROFILES.javascript;
      const source = `const fs = require('fs');
const path = require('path');

function main() {
  return true;
}`;
      const regions = mod.extractRegions(source, profile);
      const imports = regions.filter(r => r.type === 'import');
      assert.ok(imports.length > 0);
    });

    it('should extract Python declarations', () => {
      const profile = mod.LANG_PROFILES.python;
      const source = `import os

def hello():
    print("hello")

class MyClass:
    def method(self):
        pass`;
      const regions = mod.extractRegions(source, profile);
      const declNames = regions.filter(r => r.type === 'declaration').map(r => r.name);
      assert.ok(declNames.includes('hello'));
      assert.ok(declNames.includes('MyClass'));
    });

    it('should extract Go declarations', () => {
      const profile = mod.LANG_PROFILES.go;
      const source = `package main

import "fmt"

func main() {
    fmt.Println("hello")
}

type Server struct {
    port int
}`;
      const regions = mod.extractRegions(source, profile);
      const declNames = regions.filter(r => r.type === 'declaration').map(r => r.name);
      assert.ok(declNames.includes('main'));
      assert.ok(declNames.includes('Server'));
    });

    it('should extract Rust declarations', () => {
      const profile = mod.LANG_PROFILES.rust;
      const source = `use std::io;

pub fn hello() {
    println!("hello");
}

pub struct Config {
    pub name: String,
}`;
      const regions = mod.extractRegions(source, profile);
      const declNames = regions.filter(r => r.type === 'declaration').map(r => r.name);
      assert.ok(declNames.includes('hello'));
      assert.ok(declNames.includes('Config'));
    });

    it('should handle empty source', () => {
      const profile = mod.LANG_PROFILES.javascript;
      assert.deepStrictEqual(mod.extractRegions('', profile), []);
      assert.deepStrictEqual(mod.extractRegions(null, profile), []);
    });
  });

  describe('extractImports', () => {
    it('should extract JS require statements', () => {
      const profile = mod.LANG_PROFILES.javascript;
      const block = `const fs = require('fs');
const path = require('path');`;
      const imports = mod.extractImports(block, profile);
      assert.strictEqual(imports.length, 2);
    });

    it('should extract Python imports', () => {
      const profile = mod.LANG_PROFILES.python;
      const block = `import os
from pathlib import Path`;
      const imports = mod.extractImports(block, profile);
      assert.strictEqual(imports.length, 2);
    });
  });

  describe('mergeImports', () => {
    it('should merge and deduplicate imports', () => {
      const a = ["import { a } from 'x';", "import { b } from 'y';"];
      const b = ["import { b } from 'y';", "import { c } from 'z';"];
      const merged = mod.mergeImports(a, b);
      assert.strictEqual(merged.length, 3);
    });

    it('should sort merged imports', () => {
      const a = ["import z from 'z';"];
      const b = ["import a from 'a';"];
      const merged = mod.mergeImports(a, b);
      assert.strictEqual(merged[0], "import a from 'a';");
      assert.strictEqual(merged[1], "import z from 'z';");
    });
  });

  describe('validateSyntax', () => {
    it('should validate balanced braces', () => {
      const profile = mod.LANG_PROFILES.javascript;
      assert.ok(mod.validateSyntax('function f() { return 1; }', profile).valid);
    });

    it('should detect unmatched opening brace', () => {
      const profile = mod.LANG_PROFILES.javascript;
      assert.ok(!mod.validateSyntax('function f() {', profile).valid);
    });

    it('should detect unmatched closing brace', () => {
      const profile = mod.LANG_PROFILES.javascript;
      assert.ok(!mod.validateSyntax('}', profile).valid);
    });

    it('should ignore braces inside strings', () => {
      const profile = mod.LANG_PROFILES.javascript;
      assert.ok(mod.validateSyntax('const s = "{ hello }";', profile).valid);
    });

    it('should validate Python (basic)', () => {
      const profile = mod.LANG_PROFILES.python;
      assert.ok(mod.validateSyntax('def f():\n    pass', profile).valid);
    });

    it('should handle null inputs', () => {
      assert.ok(!mod.validateSyntax(null, null).valid);
    });
  });

  describe('findBlockEnd', () => {
    it('should find closing brace for JS function', () => {
      const lines = ['function foo() {', '  return 1;', '}'];
      const profile = mod.LANG_PROFILES.javascript;
      assert.strictEqual(mod.findBlockEnd(lines, 0, profile), 2);
    });

    it('should find end of Python block by dedent', () => {
      const lines = ['def foo():', '    return 1', '', 'x = 2'];
      const profile = mod.LANG_PROFILES.python;
      // Empty lines are skipped; dedent at 'x = 2' (line 3) makes end = 3-1 = 2
      assert.strictEqual(mod.findBlockEnd(lines, 0, profile), 2);
    });
  });
});
