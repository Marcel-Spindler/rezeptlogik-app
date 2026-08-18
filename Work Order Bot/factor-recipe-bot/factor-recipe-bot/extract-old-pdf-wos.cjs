const pdf = require('pdf-parse').default || require('pdf-parse');
const fs = require('fs');
const buf = fs.readFileSync('C:\\Users\\MatteoSpessotto\\Downloads\\Recipes Wednesday 12.08.2026 - New.pdf');
pdf(buf).then(data => {
  const wos = [...new Set((data.text.match(/34-\d+/g) || []))];
  wos.sort((a,b) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1]));
  console.log('WOs old PDF:', wos.length);
  console.log(JSON.stringify(wos));
}).catch(e => console.error(e.message));
