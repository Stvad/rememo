const UID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';
const UID_LENGTH = 9;

export const generateUid = () => {
  let uid = '';

  for (let i = 0; i < UID_LENGTH; i++) {
    uid += UID_ALPHABET[Math.floor(Math.random() * UID_ALPHABET.length)];
  }

  return uid;
};
