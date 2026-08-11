const fetch = require('node-fetch');

async function run() {
    try {
        console.log("Registering test user...");
        let res = await fetch('http://localhost:3000/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'testapi@test', password: 'test' })
        });
        
        let token;
        if (res.status === 400) {
            console.log("User already exists, logging in...");
            res = await fetch('http://localhost:3000/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'testapi@test', password: 'test' })
            });
            const data = await res.json();
            token = data.token;
        } else {
            const data = await res.json();
            token = data.token;
        }
        
        console.log("Got token:", token.substring(0, 20) + "...");
    } catch (e) {
        console.error(e);
    }
}
run();
