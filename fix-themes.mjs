
import fs from 'fs';
import path from 'path';

const themesDir = path.resolve(process.cwd(), 'ai-ppt-base', 'css', 'themes');
const themeFiles = fs.readdirSync(themesDir).filter(f => f.endsWith('.css') && f !== 'theme-switcher.css');

for (const file of themeFiles) {
  const filePath = path.join(themesDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Replace :root with body.theme-<theme-id>
  // The theme id is the filename without .css: e.g., business-blue.css → business-blue
  const themeId = file.replace('.css', '');
  const selector = `body.theme-${themeId}`;

  // Replace :root with the scoped selector
  content = content.replace(/:root\s*{/g, `${selector} {`);

  // For dark-mode.css, also update the body rule to be scoped
  if (themeId === 'dark-mode') {
    content = content.replace(/^body\s*{/gm, `${selector} {`);
    content = content.replace(/^\.tile,/gm, `${selector} .tile,`);
    content = content.replace(/^\.visual-card\s*{/gm, `${selector} .visual-card {`);
    content = content.replace(/^\.tile:hover,/gm, `${selector} .tile:hover,`);
    content = content.replace(/^\.visual-card:hover\s*{/gm, `${selector} .visual-card:hover {`);
    content = content.replace(/^\.overview\s*{/gm, `${selector} .overview {`);
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated ${file}`);
}
