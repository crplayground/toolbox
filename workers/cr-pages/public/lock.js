// ロック画面：パスワードの表示／非表示の切り替えだけを行う。
(function () {
  var input = document.getElementById('password');
  var btn = document.getElementById('toggle-pw');
  if (!input || !btn) return;
  btn.addEventListener('click', function () {
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'パスワードを隠す' : 'パスワードを表示する';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    input.focus();
  });
})();
