const fs = require('fs');
const code = fs.readFileSync('F:/mpscpyqwebsite-Copy/public/script.js', 'utf8');
const vm = require('vm');
const sandbox = {
    console: console,
    localStorage: { getItem: ()=>null },
    window: { location: { href: '' } },
    document: {
        getElementById: () => ({ innerHTML: '', appendChild: ()=>{} }),
        createElement: () => ({})
    },
    currentQuestions: [{ 
        qnum: 1, 
        text: 'Hello', 
        passage_text: null, 
        original_image_url: 'http://example.com/image.png' 
    }]
};
vm.createContext(sandbox);
try {
    vm.runInContext(code, sandbox);
    vm.runInContext('renderQuizQuestion(0); renderFullPaper();', sandbox);
    console.log('Script ran successfully!');
} catch(e) {
    console.error(e);
}
