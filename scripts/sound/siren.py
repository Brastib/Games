# Luftschutzsirene (Fliegeralarm) synthetisch: Anlaufen, auf- und abschwellendes Heulen, Auslaufen.
import numpy as np, wave, sys
SR = 48000
def segment_freq(kind, dur):
    t = np.arange(int(SR * dur)) / SR
    if kind == 'spinup':   # tief anlaufen bis ~430 Hz
        return 85 + (430 - 85) * (1 - np.exp(-t / 1.25))
    if kind == 'wail':     # einmal ab und wieder auf (wie beim Alarm)
        return 365 + 65 * np.cos(2 * np.pi * t / dur)
    if kind == 'winddown': # langsam auslaufen
        return 80 + (430 - 80) * np.exp(-t / 1.6)
def render(parts):
    f = np.concatenate([segment_freq(k, d) for k, d in parts])
    phase = 2 * np.pi * np.cumsum(f) / SR
    # Obertöne: ungerade stärker (Rotor/Stator „hackt“ die Luft), gerade schwächer
    sig = sum(((1.0 if k % 2 else 0.45) / k) * np.sin(k * phase) for k in range(1, 10))
    # Luftrauschen, lauter je schneller die Sirene dreht
    rng = np.random.default_rng(7)
    noise = np.convolve(rng.standard_normal(len(f)), np.ones(12) / 12, mode='same')
    speed = (f - f.min()) / (f.max() - f.min())
    sig = sig + 0.18 * noise * speed
    # Lautstärke folgt der Drehzahl (leise beim Anlaufen/Auslaufen)
    env = np.clip(0.15 + 0.85 * speed, 0, 1)
    fade = np.ones(len(f)); n = int(0.05 * SR); fade[:n] = np.linspace(0, 1, n); fade[-n:] = np.linspace(1, 0, n)
    out = sig * env * fade
    return (out / np.abs(out).max() * 0.8 * 32767).astype(np.int16)
def save(name, data):
    with wave.open(name, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(data.tobytes())
save('siren_intro.wav', render([('spinup', 3.5), ('wail', 4.0)]))
save('siren_outro.wav', render([('wail', 2.0), ('winddown', 4.5)]))
print('ok')
