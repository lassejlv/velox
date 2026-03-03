interface Post {
  userId: number;
  id: number;
  title: string;
  body: string;
}

async function fetchPosts(): Promise<Post[]> {
  const res = await fetch("https://jsonplaceholder.typicode.com/posts?_limit=3");
  return res.json();
}

const posts = await fetchPosts();

posts.forEach((post: Post) => {
  console.log(`#${post.id}: ${post.title}`);
});
