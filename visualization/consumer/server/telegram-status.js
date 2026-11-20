const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const fans = { off: 'Mati', low: 'Rendah', medium: 'Sedang', high: 'Tinggi', auto: 'Otomatis' };
const conditions = { clear: 'Cerah', clouds: 'Berawan', rain: 'Hujan', drizzle: 'Gerimis', thunderstorm: 'Badai petir',
  snow: 'Salju', mist: 'Berkabut', fog: 'Berkabut', haze: 'Berkabut' };
const numeric = (value, unit = '') => finite(value)
  ? `${value.toLocaleString('id-ID', { maximumFractionDigits: 1 })}${unit}` : 'Tidak tersedia';
const power = (value) => typeof value === 'boolean' ? (value ? 'Nyala' : 'Mati') : 'Tidak diketahui';
const fan = (value) => typeof value === 'string' && Object.hasOwn(fans, value.toLowerCase()) ? fans[value.toLowerCase()] : 'Tidak diketahui';

function duration(seconds) {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} jam`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} menit`;
  return `${Math.floor(seconds)} detik`;
}

export function formatTelegramStatus({ snapshot, mqttConnected, subscriptionsReady,
  staleAfterSeconds = 30, timezone = 'Asia/Jakarta', now = Date.now() }) {
  const dateFormatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short', hour12: false,
  });
  const metadata = snapshot.metadata || {};
  const valid = (key) => record(snapshot[key]) && metadata[key]?.schema_valid === true;
  const age = (key) => {
    const received = Date.parse(metadata[key]?.received_at);
    return Number.isFinite(received) ? Math.max(0, (now - received) / 1000) : null;
  };
  const fresh = (key) => valid(key) && age(key) !== null && age(key) <= staleAfterSeconds && !metadata[key]?.retained;
  const freshness = (key) => {
    if (!record(snapshot[key])) return 'belum ada data';
    if (!valid(key)) return 'format data tidak valid';
    if (age(key) === null) return 'waktu data tidak diketahui';
    if (metadata[key]?.retained) return `data tersimpan, diterima ${duration(age(key))} lalu`;
    return age(key) > staleAfterSeconds ? `data lama, ${duration(age(key))} lalu` : `${duration(age(key))} lalu`;
  };
  const updated = (key) => {
    const received = Date.parse(metadata[key]?.received_at);
    return Number.isFinite(received) ? dateFormatter.format(received) : 'Belum ada';
  };
  const node = (key, statusKey) => {
    if (!mqttConnected) return 'Tidak terhubung (MQTT terputus)';
    if (valid(statusKey) && snapshot[statusKey].online === false) return 'Offline';
    if (fresh(key)) return 'Terhubung';
    return `Menunggu pembaruan (${freshness(key)})`;
  };

  const tx = valid('transmit') ? snapshot.transmit : null;
  const rx = valid('receive') ? snapshot.receive : null;
  const sensorReady = tx?.sensor_ok === true && tx?.warmup !== true;
  const sensorNote = tx?.warmup === true ? 'sensor sedang disiapkan'
    : tx && tx.sensor_ok !== true ? 'sensor suhu tidak valid' : freshness('transmit');
  const lines = [
    'AutoClimate — Status ruangan',
    `Waktu: ${dateFormatter.format(now)}`,
    `MQTT: ${!mqttConnected ? 'Terputus' : subscriptionsReady ? 'Terhubung' : 'Menyiapkan koneksi topik'}`,
    `Pengendali: ${node('transmit', 'transmit_status')}`,
    `Penerima: ${node('receive', 'receive_status')}`,
    '',
    `Suhu ruangan: ${sensorReady ? numeric(tx.temp, '°C') : 'Tidak tersedia'} (${sensorNote})`,
    `Kelembapan: ${sensorReady ? numeric(tx.hum, '%') : 'Tidak tersedia'}`,
    `Gerakan: ${typeof tx?.motion === 'boolean' ? tx.motion ? 'Terdeteksi' : 'Tidak ada' : 'Tidak diketahui'}`,
    `AC target: ${power(tx?.relay_on)} / ${numeric(tx?.target_temp, '°C')} / Kipas ${fan(tx?.fan_speed)}`,
  ];
  if (!fresh('transmit') || !mqttConnected) lines.push(`Status target: pembacaan terakhir (${freshness('transmit')})`);
  lines.push(`AC penerima: ${rx?.state_valid === true
    ? `${power(rx.ac_power_state)} / ${numeric(rx.temp, '°C')} / Kipas ${fan(rx.fan_speed)} (${freshness('receive')})`
    : 'Belum ada konfirmasi yang valid'}`);
  if (mqttConnected && fresh('transmit') && fresh('receive') && rx.state_valid === true
    && (tx.relay_on !== rx.ac_power_state || tx.target_temp !== rx.temp || tx.fan_speed !== rx.fan_speed)) {
    lines.push('Konfirmasi AC berbeda dari target.');
  }
  let mode = 'Tidak diketahui';
  if (typeof tx?.override === 'boolean') {
    mode = tx.override ? 'Manual' : 'Otomatis';
    if (tx.override && tx.override_indefinite === true) mode += ' (sampai dilepas)';
    else if (tx.override && finite(tx.override_remaining_s) && tx.override_remaining_s >= 0) {
      mode += ` (${duration(tx.override_remaining_s)} tersisa pada pembaruan terakhir)`;
    }
  }
  lines.push(`Mode: ${mode}`, `Pembaruan ruangan: ${updated('transmit')}`);

  if (record(snapshot.weather)) {
    const weather = snapshot.weather;
    const value = weather.main?.temp;
    const outside = finite(value) ? (value > 120 ? value - 273.15 : value) : null;
    const condition = weather.weather?.[0]?.main;
    const label = typeof condition === 'string' && Object.hasOwn(conditions, condition.toLowerCase()) ? conditions[condition.toLowerCase()] : 'Kondisi tidak diketahui';
    lines.push('', `Cuaca luar: ${numeric(outside, '°C')} / ${label}`,
      `Kelembapan luar: ${numeric(weather.main?.humidity, '%')}`,
      `Pembaruan cuaca: ${updated('weather')} (${freshness('weather')})`);
  } else lines.push('', 'Cuaca luar: belum ada data');
  return lines.join('\n');
}
