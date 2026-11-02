export async function dynamicOrder(url: string) {
  const response = await fetch(url);
  const order = await response.json();
  return order.id;
}
