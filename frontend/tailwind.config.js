/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          deep: '#14163d',
          purple: '#472562',
          magenta: '#ac4886',
          pink: '#f298a9',
          peach: '#fecab8',
        },
        soteria: {
          // Dark mode defaults (used directly in dark: classes)
          bg: 'var(--s-bg)',
          surface: 'var(--s-surface)',
          card: 'var(--s-card)',
          border: 'var(--s-border)',
          hover: 'var(--s-hover)',
          text: 'var(--s-text)',
          muted: 'var(--s-muted)',
          accent: '#ac4886',
          success: '#34d399',
          warning: '#fbbf24',
          danger: '#f87171',
        },
      },
      fontFamily: {
        sans: ['Montserrat', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
