function search(req, items) {
  // ruleid: radr.javascript.regexp-from-variable
  const re = new RegExp(req.query.q);
  // ruleid: radr.javascript.regexp-from-variable
  const re2 = RegExp(req.body.pattern, "i");
  // ok: radr.javascript.regexp-from-variable
  const fixed = new RegExp("^[a-z]+$");
  return items.filter((x) => re.test(x) || re2.test(x) || fixed.test(x));
}
