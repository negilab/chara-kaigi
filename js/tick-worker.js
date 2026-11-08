// タブが裏にあっても止まらない時計（ページの setInterval は裏に回ると1秒に1回まで落とされるため）
setInterval(() => postMessage(0), 33);
