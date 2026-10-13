// Writes sbom.json (CycloneDX 1.5) from package-lock.json: every production
// dependency with its exact version, licence and integrity hash.
// npm's own `npm sbom` refuses to run here because two Atlassian UI packages
// declare an older React peer version, so we read the lock file directly.
import { readFileSync, writeFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const components = Object.entries(lock.packages ?? {})
  .filter(([path, p]) => path.startsWith('node_modules/') && !p.dev && p.version)
  .map(([path, p]) => {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const purlName = name.startsWith('@') ? `%40${name.slice(1)}` : name;
    const c = {
      type: 'library',
      'bom-ref': `${name}@${p.version}`,
      name,
      version: p.version,
      purl: `pkg:npm/${purlName}@${p.version}`,
    };
    if (p.license) c.licenses = [{ expression: String(p.license) }];
    if (p.integrity?.startsWith('sha512-')) {
      c.hashes = [{ alg: 'SHA-512', content: Buffer.from(p.integrity.slice(7), 'base64').toString('hex') }];
    }
    return c;
  })
  .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

const unique = [...new Map(components.map((c) => [c['bom-ref'], c])).values()];

writeFileSync(
  'sbom.json',
  JSON.stringify(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        component: { type: 'application', name: pkg.name, version: pkg.version },
        supplier: { name: 'TELCOMA Global' },
      },
      components: unique,
    },
    null,
    2
  ) + '\n'
);
console.log(`sbom.json: ${unique.length} components`);
