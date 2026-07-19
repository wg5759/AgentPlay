/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        player: {
          bg: '#0a0a0a',
          surface: '#161616',
          accent: '#3b82f6'
        }
      }
    }
  },
  plugins: []
}
