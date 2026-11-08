// Keep dispatch and recovery on the same identifier contract. Exact dot segments
// remain recoverable through the query endpoint because URLs normalize path dots.
export const callIdentifierPattern = /^[A-Za-z0-9._:-]{1,200}$/;
