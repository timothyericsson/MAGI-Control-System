/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        evaBg: "#0A0F1E",
        magiBlue: "#00D1FF",
        magiOrange: "#FFA726",
        magiGreen: "#00FF7F",
        evaGrid: "#14203A"
      },
      boxShadow: {
        "magi-glow-blue": "0 0 15px rgba(0,209,255,0.6)",
        "magi-glow-orange": "0 0 15px rgba(255,167,38,0.6)",
        "magi-glow-green": "0 0 15px rgba(0,255,127,0.6)"
      }
    },
  },
  plugins: [],
};


