/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./index.html', './assets/app.js'],
    darkMode: 'class',
    theme: { extend: { fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] } } },
};
