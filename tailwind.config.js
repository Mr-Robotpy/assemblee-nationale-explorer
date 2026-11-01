/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./index.html', './assets/app.js'],
    darkMode: 'class',
    theme: { extend: { screens: { xs: '400px' }, fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] } } },
};
