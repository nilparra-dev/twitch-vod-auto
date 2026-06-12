import base64

def xor_data(data, key):
    return bytes([data[i] ^ key[i % len(key)] for i in range(len(data))])

# Datos extraídos de tu petición
cookie_name_b64 = "Qr1B4j3mt1CvGgdX7VLv+0mYT8Ul+4pCc9DFhI+NvEnKbFWS"
cookie_value = "v1uds0JQSDboF"

# Decodificamos el nombre de la cookie (Base64 a Bytes)
encrypted_bytes = base64.b64decode(cookie_name_b64)

print(f"--- Intentando XOR con la clave: {cookie_value} ---")
decoded = xor_data(encrypted_bytes, cookie_value.encode())
print(f"Resultado: {decoded}")
print("-" * 50)

# Intento 2: ¿Quizás el valor de la cookie es HEX?
try:
    hex_key = bytes.fromhex(cookie_value)
    print("--- Intentando XOR con clave interpretada como HEX ---")
    print(xor_data(encrypted_bytes, hex_key))
except:
    pass

# Intento 3: ¿Es una Flag en formato estándar? (Ataque de texto claro conocido)
# Si el resultado empieza por 'flag{' o 'ctf{', podemos deducir la clave
def recover_key(ciphertext, plaintext_start):
    return bytes([ciphertext[i] ^ ord(plaintext_start[i]) for i in range(len(plaintext_start))])

print("--- Deduciendo clave si empezara por 'flag{' ---")
potential_key_php = recover_key(encrypted_bytes, "O:8:\"") # O un objeto
print(f"Clave potencial (PHP): {potential_key_php}")