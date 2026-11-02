import axios from 'axios';

export async function contactEmail() {
  const response = await axios.get('/profile');
  return response.data.email.toLowerCase();
}
