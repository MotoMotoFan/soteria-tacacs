#!/usr/bin/env node
// Manage the dev-server allowed hosts (allowed-hosts.json) from the CLI.
// No network exposure: editing requires shell access to this machine. The dev
// server watches the file (see vite.config.ts) and restarts to apply changes.
//
//   npm run hosts -- list
//   npm run hosts -- add <domain> [--local]
//   npm run hosts -- remove <domain>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '..', 'allowed-hosts.json');

const DEFAULTS = {
  publicDomains: ['soteria.infra-sandbox.com', '.infra-sandbox.com'],
  localDomains: ['soteria.lab.home', '.lab.home'],
};

const uniq = (arr) => [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];

function load() {
  if (!existsSync(FILE)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'));
    return {
      publicDomains: Array.isArray(raw.publicDomains) ? uniq(raw.publicDomains) : [],
      localDomains: Array.isArray(raw.localDomains) ? uniq(raw.localDomains) : [],
    };
  } catch (e) {
    console.error(`Could not parse ${FILE}: ${e.message}`);
    process.exit(1);
  }
}

function save(cfg) {
  writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n');
}

const effective = (cfg) => uniq([...cfg.publicDomains, ...cfg.localDomains, 'localhost', '127.0.0.1']);

function printList(cfg) {
  const section = (title, list) => {
    console.log(`\n${title}:`);
    if (list.length === 0) console.log('  (none)');
    else list.forEach((d) => console.log(`  ${d}`));
  };
  section('Public domains', cfg.publicDomains);
  section('Local domains', cfg.localDomains);
  section('Effective allowedHosts (what Vite enforces)', effective(cfg));
  console.log('');
}

function usage() {
  console.log(`Manage the dev-server allowed hosts (allowed-hosts.json).

Usage:
  npm run hosts -- list
  npm run hosts -- add <domain> [--local]     # default: public domain
  npm run hosts -- remove <domain>

Notes:
  - Prefix a domain with a dot for a wildcard, e.g. .example.com
  - localhost / 127.0.0.1 are always allowed.
  - If the dev server is running it auto-restarts to apply; otherwise the
    change applies next time you start it.`);
}

const [cmd, ...rest] = process.argv.slice(2);
const isLocal = rest.includes('--local');
const domain = rest.find((a) => !a.startsWith('--'));
const cfg = load();

switch (cmd) {
  case 'list':
    printList(cfg);
    break;

  case 'add': {
    if (!domain) { console.error('Error: a domain is required.\n'); usage(); process.exit(1); }
    const key = isLocal ? 'localDomains' : 'publicDomains';
    if (cfg.publicDomains.includes(domain) || cfg.localDomains.includes(domain)) {
      console.log(`"${domain}" is already in the list.`);
    } else {
      cfg[key] = uniq([...cfg[key], domain]);
      save(cfg);
      console.log(`Added "${domain}" to ${isLocal ? 'local' : 'public'} domains.`);
    }
    printList(cfg);
    break;
  }

  case 'remove': {
    if (!domain) { console.error('Error: a domain is required.\n'); usage(); process.exit(1); }
    const before = cfg.publicDomains.length + cfg.localDomains.length;
    cfg.publicDomains = cfg.publicDomains.filter((d) => d !== domain);
    cfg.localDomains = cfg.localDomains.filter((d) => d !== domain);
    if (cfg.publicDomains.length + cfg.localDomains.length === before) {
      console.log(`"${domain}" was not in the list.`);
    } else {
      save(cfg);
      console.log(`Removed "${domain}".`);
    }
    printList(cfg);
    break;
  }

  case 'help': case '--help': case '-h': case undefined:
    usage();
    break;

  default:
    console.error(`Unknown command: ${cmd}\n`);
    usage();
    process.exit(1);
}
