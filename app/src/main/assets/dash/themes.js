/* Shared RaceDash themes (dashboard + launcher). */
window.RD_THEMES = {
    apex: { name: 'Apex Red', gauge: 'segment', vars: {
      bg: '#0a0a0c', panel: '#141418', line: '#26262e', text: '#f4f4f6', dim: '#80808c',
      accent: '#ff2a2a', accent2: '#ff8a00', danger: '#ff1744', glow: 'rgba(255,42,42,.6)',
      bgimg: 'repeating-linear-gradient(45deg,rgba(255,255,255,.028) 0 2px,transparent 2px 6px)',
      onaccent: '#ffffff', ledoff: '#1c1c22', mapbg: '#0e0e12', mapfilter: 'invert(1) hue-rotate(180deg) brightness(.85) contrast(.92) saturate(.55)' } },
    neon: { name: 'Neon Drive', gauge: 'segment', vars: {
      bg: '#0b0418', panel: '#170a2e', line: '#3a1d6e', text: '#f6eaff', dim: '#9b7fc9',
      accent: '#ff2bd6', accent2: '#00e5ff', danger: '#ff3d71', glow: 'rgba(255,43,214,.6)',
      bgimg: 'linear-gradient(180deg,#1a0838 0%,#0b0418 65%)',
      onaccent: '#ffffff', ledoff: '#24113f', mapbg: '#120726', mapfilter: 'invert(1) hue-rotate(180deg) brightness(.8) contrast(.95) sepia(.6) hue-rotate(225deg) saturate(2.2)' } },
    gt: { name: 'GT Classic', gauge: 'needle', vars: {
      bg: '#141518', panel: '#1d1f23', line: '#33363c', text: '#f1efe9', dim: '#8d8a82',
      accent: '#ff7a00', accent2: '#ffd29a', danger: '#ff3b30', glow: 'rgba(255,122,0,.5)',
      bgimg: 'radial-gradient(circle at 30% 20%,#23252a,#141518 70%)',
      onaccent: '#1a0c00', ledoff: '#26282d', mapbg: '#17181b', mapfilter: 'invert(1) hue-rotate(180deg) brightness(.85) contrast(.9) saturate(.3)' } },
    volt: { name: 'Volt EV', gauge: 'ring', vars: {
      bg: '#05070a', panel: '#0d1218', line: '#1b2530', text: '#eaf6ff', dim: '#6f8597',
      accent: '#3ad1ff', accent2: '#7cffcb', danger: '#ff4d6d', glow: 'rgba(58,209,255,.55)',
      bgimg: 'none', onaccent: '#001018', ledoff: '#121a22', mapbg: '#080c10', mapfilter: 'invert(1) hue-rotate(180deg) brightness(.8) contrast(.95) sepia(.35) hue-rotate(150deg) saturate(1.6)' } },
    toxic: { name: 'Toxic', gauge: 'segment', vars: {
      bg: '#050805', panel: '#0d140c', line: '#1f3019', text: '#efffe0', dim: '#7c9a6a',
      accent: '#9dff00', accent2: '#f0ff3d', danger: '#ff3b3b', glow: 'rgba(157,255,0,.5)',
      bgimg: 'repeating-linear-gradient(-45deg,rgba(157,255,0,.035) 0 3px,transparent 3px 9px)',
      onaccent: '#0b1400', ledoff: '#152013', mapbg: '#081008', mapfilter: 'invert(1) hue-rotate(180deg) brightness(.8) contrast(.95) sepia(.6) hue-rotate(45deg) saturate(1.8)' } },
    day: { name: 'Daylight', gauge: 'ring', vars: {
      bg: '#e9edf2', panel: '#ffffff', line: '#cfd6df', text: '#10151c', dim: '#5d6b7a',
      accent: '#0a6cff', accent2: '#00b386', danger: '#e0102f', glow: 'rgba(10,108,255,.3)',
      bgimg: 'none', onaccent: '#ffffff', ledoff: '#d3d9e1', mapbg: '#f2efe9', mapfilter: 'saturate(.85)' } },
    stealth: { name: 'Night Stealth', gauge: 'needle', vars: {
      bg: '#000000', panel: '#080404', line: '#1e0c0c', text: '#d23a3a', dim: '#6e2424',
      accent: '#c3122a', accent2: '#d23a3a', danger: '#ff2a2a', glow: 'rgba(195,18,42,.45)',
      bgimg: 'none', onaccent: '#000000', ledoff: '#140808', mapbg: '#050202',
      mapfilter: 'invert(1) hue-rotate(180deg) brightness(.5) sepia(1) hue-rotate(-30deg) saturate(2.2)' } },
  };
