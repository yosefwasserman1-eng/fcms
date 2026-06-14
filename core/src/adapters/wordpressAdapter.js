const axios = require('axios');

class WordPressAdapter {
    constructor() {
        this.baseUrl = 'http://wordpress/wp-json/wp/v2';
        // הכנס כאן את הפרטים שלך (עדיף להעביר אותם דרך משתני סביבה בעתיד)
        this.auth = {
            username: 'yosef', // שם המשתמש שלך
            password: '00xK uxyM e4r8 YepO LoA3 DF3Z' // סיסמת האפליקציה (עם הרווחים)
        };
    }

    // --- קריאה (כבר יש לנו) ---
    async getPosts() {
        try {
            const response = await axios.get(`${this.baseUrl}/posts`);
            return response.data.map(post => this._mapPost(post));
        } catch (error) {
            console.error('Fetch Error:', error.message);
            return [];
        }
    }

    // --- יצירה (חדש!) ---
    async createPost(title, content, status = 'publish') {
        try {
            const response = await axios.post(
                `${this.baseUrl}/posts`,
                {
                    title: title,
                    content: content,
                    status: status // 'publish', 'draft', או 'private'
                },
                { auth: this.auth }
            );
            console.log('Post Created Successfully!');
            return this._mapPost(response.data);
        } catch (error) {
            console.error('Create Error:', error.response ? error.response.data : error.message);
            return null;
        }
    }

    // --- עדכון (חדש!) ---
    async updatePost(postId, data) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/posts/${postId}`,
                data, // למשל { title: "כותרת חדשה" }
                { auth: this.auth }
            );
            return this._mapPost(response.data);
        } catch (error) {
            console.error('Update Error:', error.response ? error.response.data : error.message);
            return null;
        }
    }

    _mapPost(post) {
        return {
            id: post.id,
            title: post.title.rendered,
            content: post.content.rendered,
            link: post.link,
            source: 'WordPress'
        };
    }
}

module.exports = new WordPressAdapter();